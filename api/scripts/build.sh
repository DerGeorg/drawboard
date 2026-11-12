#!/usr/bin/env bash
# =============================================================================
# scripts/build.sh - build of an API contract repository, without Gradle
#
# Reference implementation from ci/components (examples/contract-build.sh).
# Copy it unchanged to scripts/build.sh of the contract repository; what
# differs per repository (coordinates, package, npm name, Keycloak issuer,
# tool versions) goes into contract.env (template: examples/contract.env).
# The pipeline (component openapi >= 2.8.0, input build-script:
# scripts/build.sh) calls exactly these four commands:
#
#   lint       Redocly lint with the rules in redocly.yaml
#   bundle     Redocly bundle -> ONE file, version + Keycloak issuer stamped
#              ($OPENAPI_BUNDLE, default build/openapi/openapi.yaml)
#   breaking   oasdiff against the bundle of the last tag. A breaking change
#              no commit since that tag declares ("feat!:", "BREAKING CHANGE:")
#              fails (BREAKING_CHECK=enforce|warn|off)
#   build      bundle, generate (kotlin-spring + typescript-angular), model
#              check, Kotlin jar + sources jar + POM in Maven layout
#              ($MAVEN_STAGING_DIR), npm package as .tgz ($NPM_PACKAGE_DIR)
#
# Locally there is more:
#
#   all        lint + breaking + build
#   generate   only the generators (for a look at the generated code)
#   install    build, then copy the Maven publication into ~/.m2/repository
#              (a backend with mavenLocal() picks it up, VERSION=0.0.1-SNAPSHOT)
#   clean      remove build/
#
# Needs: bash, curl, git (breaking), tar, a JDK 25 (java, jar) and Node 24
# (node, npm, npx) on the PATH. Everything else is downloaded on first use,
# checksum-verified, into $CACHE_DIR: openapi-generator-cli (Maven Central),
# kotlinc (GitHub release of JetBrains/kotlin), oasdiff (GitHub release), the
# compileOnly dependencies (Maven Central, versions from the Spring Boot BOM).
# Redocly runs through npx, ng-packagr through the generated package.json.
#
# Environment (all optional; the pipeline sets them):
#   VERSION              contract version          (0.0.1-SNAPSHOT)
#   OPENAPI_SPEC         root file of the contract  (openapi.yaml)
#   OPENAPI_BUNDLE       stamped bundle             (build/openapi/openapi.yaml)
#   MAVEN_STAGING_DIR    Maven publication          (build/maven-staging)
#   NPM_PACKAGE_DIR      npm .tgz                   (build/npm)
#   KOTLIN, TYPESCRIPT   true/false: build the jar / the npm package (true)
#   CACHE_DIR            downloaded tools and jars  (~/.cache/contract-build)
#   BREAKING_CHECK       enforce | warn | off       (enforce)
#   BASE_REF             ref the breaking check compares with (last tag)
#   OASDIFF_SEVERITY_OVERRIDES  "rule:level ..."    (see below)
#   OASDIFF_SEVERITY_FILE       oasdiff-severity.txt, "<rule> <level>" lines
#   OASDIFF_IGNORE_FILE         oasdiff-ignore.txt, single findings
#   OASDIFF_REPORT_DIR   oasdiff.txt + oasdiff-junit.xml (build/oasdiff); the
#                        JUnit report fails only where the check fails
#                        (an undeclared break under enforce)
#   MAVEN_REPOSITORY     where jars come from       (Maven Central)
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

# ---- Configuration (per repository): contract.env ---------------------------
# Everything that differs between contract repositories lives in contract.env
# (shell syntax, KEY=value) next to openapi.yaml - this script is copied
# unchanged. Template: ci/components examples/contract.env.
CONTRACT_ENV="${CONTRACT_ENV:-contract.env}"
# shellcheck disable=SC1090
[ -f "$CONTRACT_ENV" ] && . "./$CONTRACT_ENV"

# Required (no sensible default):
#   API_NAME          stem of every published name: Maven artifact
#                     <API_NAME>-kotlin, spec in the jar at
#                     META-INF/resources/openapi/<API_NAME>.yaml
#   API_GROUP         Maven group (dergeorg projects: at.dergeorg.<app>)
#   API_BASE_PACKAGE  Kotlin package of the generated interfaces (.api), models
#                     (.model) and config (.config); under the app's root package
#   API_NPM_NAME      npm package of the Angular client; scope = root group
for v in API_NAME API_GROUP API_BASE_PACKAGE API_NPM_NAME; do
  eval "[ -n \"\${$v:-}\" ]" || { echo "ERROR: $v is not set ($CONTRACT_ENV)." >&2; exit 2; }
done
API_REACTIVE="${API_REACTIVE:-true}"   # true = WebFlux + coroutines, false = Spring MVC
API_DESCRIPTION="${API_DESCRIPTION:-Generated Kotlin Spring interfaces and models of $API_NAME}"
# Repository link in the generated package.json / README
GIT_HOST="${GIT_HOST:-gitlab.dergeorg.at}"
GIT_USER_ID="${GIT_USER_ID:-}"
GIT_REPO_ID="${GIT_REPO_ID:-api}"
# The bundle gets KEYCLOAK_ISSUER wherever the contract says
# KEYCLOAK_PLACEHOLDER. Empty placeholder = no Keycloak, nothing is replaced.
KEYCLOAK_PLACEHOLDER="${KEYCLOAK_PLACEHOLDER-}"
KEYCLOAK_ISSUER="${KEYCLOAK_ISSUER:-$KEYCLOAK_PLACEHOLDER}"
# Schemas for the model check: common/common.yaml (one file) or common/schemas/
SCHEMAS="${SCHEMAS:-$( [ -f common/common.yaml ] && echo common/common.yaml || echo common/schemas )}"
MODEL_CHECK="${MODEL_CHECK:-scripts/check-generated-models.mjs}"
# kotlin.uuid.Uuid and kotlin.time.Instant instead of java.util.UUID and
# java.time.OffsetDateTime, in models and parameters. Uuid is still
# experimental in Kotlin 2.3 -> opt-in (the backend needs the same flag).
KOTLIN_TYPE_MAPPINGS="${KOTLIN_TYPE_MAPPINGS-UUID=kotlin.uuid.Uuid,DateTime=kotlin.time.Instant}"
KOTLIN_OPT_IN="${KOTLIN_OPT_IN-kotlin.uuid.ExperimentalUuidApi}"
# compileOnly: the consuming Spring Boot service brings these through its own
# Boot BOM, so the jar never dictates versions (its POM lists kotlin-stdlib
# only). Without a version = the version of SPRING_BOOT_VERSION's BOM.
COMPILE_ONLY="${COMPILE_ONLY:-
  org.springframework:spring-web
  org.springframework:spring-context
  jakarta.validation:jakarta.validation-api
  com.fasterxml.jackson.core:jackson-annotations
  io.swagger.core.v3:swagger-annotations-jakarta:2.2.55
  org.jetbrains.kotlinx:kotlinx-coroutines-core
}"
# Tool versions: pinned in contract.env with "# renovate:" markers; these are
# the versions the reference was tested with.
SPRING_BOOT_VERSION="${SPRING_BOOT_VERSION:-4.1.1}"
KOTLIN_VERSION="${KOTLIN_VERSION:-2.3.21}"
OPENAPI_GENERATOR_VERSION="${OPENAPI_GENERATOR_VERSION:-7.25.0}"
REDOCLY_VERSION="${REDOCLY_VERSION:-2.55.0}"
OASDIFF_VERSION="${OASDIFF_VERSION:-1.32.1}"
NG_VERSION="${NG_VERSION:-22.0.0}"     # Angular version the client is written for
JVM_TARGET="${JVM_TARGET:-25}"

# ---- Environment ------------------------------------------------------------
VERSION="${VERSION:-0.0.1-SNAPSHOT}"
OPENAPI_SPEC="${OPENAPI_SPEC:-openapi.yaml}"
OPENAPI_BUNDLE="${OPENAPI_BUNDLE:-build/openapi/openapi.yaml}"
MAVEN_STAGING_DIR="${MAVEN_STAGING_DIR:-build/maven-staging}"
NPM_PACKAGE_DIR="${NPM_PACKAGE_DIR:-build/npm}"
KOTLIN="${KOTLIN:-true}"
TYPESCRIPT="${TYPESCRIPT:-true}"
CACHE_DIR="${CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/contract-build}"
BREAKING_CHECK="${BREAKING_CHECK:-enforce}"
# House rule: a new enum value in a response (e.g. a new ErrorCode) is not
# breaking - clients must tolerate unknown values; removing an optional
# response property is.
OASDIFF_SEVERITY_OVERRIDES="${OASDIFF_SEVERITY_OVERRIDES-response-property-enum-value-added:info response-optional-property-removed:err}"
OASDIFF_SEVERITY_FILE="${OASDIFF_SEVERITY_FILE-oasdiff-severity.txt}"
OASDIFF_IGNORE_FILE="${OASDIFF_IGNORE_FILE-oasdiff-ignore.txt}"
OASDIFF_REPORT_DIR="${OASDIFF_REPORT_DIR:-build/oasdiff}"
MAVEN_REPOSITORY="${MAVEN_REPOSITORY:-https://repo.maven.apache.org/maven2}"

ARTIFACT="$API_NAME-kotlin"
SPEC_RESOURCE="META-INF/resources/openapi/$API_NAME.yaml"
KOTLIN_GEN=build/generated/openapi
TS_GEN=build/generated/typescript-angular
REDOCLY="@redocly/cli@$REDOCLY_VERSION"
export REDOCLY_TELEMETRY=off REDOCLY_SUPPRESS_UPDATE_NOTICE=true

# ---- Helpers ----------------------------------------------------------------
log()  { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is missing on the PATH ($2)."; }
abspath() { case "$1" in /*) echo "$1" ;; *) echo "$ROOT/$1" ;; esac; }

# digest <md5|sha1|sha256|sha512> <file>: hex digest on Linux and macOS
digest() {
  if command -v "${1}sum" >/dev/null 2>&1; then "${1}sum" "$2" | cut -d' ' -f1
  elif [ "$1" = md5 ]; then md5 -q "$2"
  else shasum -a "${1#sha}" "$2" | cut -d' ' -f1
  fi
}

# download <url> <target> <alg> <expected digest or URL of the digest file>
download() {
  local url=$1 target=$2 alg=$3 expected=$4 tmp
  [ -s "$target" ] && return 0
  mkdir -p "$(dirname "$target")"
  case "$expected" in http*) expected=$(curl -fsSL --retry 3 "$expected" | awk '{print $1; exit}') ;; esac
  [ -n "$expected" ] || fail "no checksum for $url"
  tmp="$target.part"
  curl -fsSL --retry 3 -o "$tmp" "$url" || fail "download failed: $url"
  [ "$(digest "$alg" "$tmp")" = "$expected" ] || { rm -f "$tmp"; fail "checksum mismatch: $url"; }
  mv "$tmp" "$target"
}

redocly() { npx --yes "$REDOCLY" "$@"; }

TMP_DIRS=""
# shellcheck disable=SC2086 # a list of directories
trap 'rm -rf $TMP_DIRS' EXIT

# ---- Tools ------------------------------------------------------------------
generator_jar() {
  local p="org/openapitools/openapi-generator-cli/$OPENAPI_GENERATOR_VERSION/openapi-generator-cli-$OPENAPI_GENERATOR_VERSION.jar"
  local jar="$CACHE_DIR/tools/openapi-generator-cli-$OPENAPI_GENERATOR_VERSION.jar"
  download "$MAVEN_REPOSITORY/$p" "$jar" sha1 "$MAVEN_REPOSITORY/$p.sha1"
  echo "$jar"
}

kotlin_home() {
  local home="$CACHE_DIR/tools/kotlinc-$KOTLIN_VERSION" zip
  if [ ! -x "$home/bin/kotlinc" ]; then
    local u="https://github.com/JetBrains/kotlin/releases/download/v$KOTLIN_VERSION/kotlin-compiler-$KOTLIN_VERSION.zip"
    zip="$CACHE_DIR/tools/kotlin-compiler-$KOTLIN_VERSION.zip"
    log "kotlinc $KOTLIN_VERSION is downloaded" >&2
    download "$u" "$zip" sha256 "$u.sha256"
    rm -rf "$home.tmp" && mkdir -p "$home.tmp"
    (cd "$home.tmp" && jar xf "$zip")           # the JDK's jar, no unzip needed
    chmod +x "$home.tmp/kotlinc/bin/"*
    rm -rf "$home" && mv "$home.tmp/kotlinc" "$home" && rm -rf "$home.tmp" "$zip"
  fi
  echo "$home"
}

oasdiff_bin() {
  local bin="$CACHE_DIR/tools/oasdiff-$OASDIFF_VERSION/oasdiff" os arch t
  if [ ! -x "$bin" ]; then
    case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) fail "oasdiff: unsupported OS $(uname -s)" ;; esac
    case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) fail "oasdiff: architecture $(uname -m)" ;; esac
    [ "$os" = darwin ] && arch=all
    t="oasdiff_${OASDIFF_VERSION}_${os}_${arch}.tar.gz"
    local u="https://github.com/oasdiff/oasdiff/releases/download/v$OASDIFF_VERSION"
    local sum
    sum=$(curl -fsSL --retry 3 "$u/checksums.txt" | awk -v t="$t" '$2 == t {print $1}')
    download "$u/$t" "$CACHE_DIR/tools/$t" sha256 "$sum"
    mkdir -p "$(dirname "$bin")"
    tar -xzf "$CACHE_DIR/tools/$t" -C "$(dirname "$bin")" oasdiff
    rm -f "$CACHE_DIR/tools/$t"
  fi
  echo "$bin"
}

# compile_classpath: the compileOnly jars with their compile-scope transitive
# dependencies, versions from the Spring Boot BOM (a tiny Maven resolver in
# Java, so the script needs no Maven and no Gradle). Prints a classpath.
compile_classpath() {
  local src="$CACHE_DIR/tools/Resolve.java"
  mkdir -p "$CACHE_DIR/tools"
  cat > "$src" <<'JAVA'
import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.*;

/**
 * java Resolve.java <repository> <cache> <bom g:a:v> <g:a[:v]>...
 * Prints the jars of the compile classpath, one per line: the given
 * artifacts plus their compile-scope dependencies (transitive, without
 * optional ones, with exclusions), versions from the BOM where it has one.
 * Enough for Spring, Jackson, Jakarta, Swagger and kotlinx POMs - no version
 * ranges, no profiles.
 */
public class Resolve {
    static String repo;
    static Path cache;
    static final HttpClient HTTP = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL).build();
    static final Map<String, Model> MODELS = new HashMap<>();

    record Dep(String g, String a, String v, String scope, boolean optional, String type, String classifier, Set<String> exclusions) {
        String ga() { return g + ":" + a; }
    }

    static final class Model {
        String g, a, v, packaging = "jar";
        final Map<String, String> props = new HashMap<>();
        final Map<String, Dep> managed = new LinkedHashMap<>();
        final List<Dep> deps = new ArrayList<>();
    }

    public static void main(String[] args) throws Exception {
        repo = args[0].replaceAll("/+$", "");
        cache = Path.of(args[1]);
        String[] b = args[2].split(":");
        Map<String, Dep> bom = load(b[0], b[1], b[2]).managed;
        record Node(String g, String a, String v, Set<String> exclusions) {}
        Deque<Node> queue = new ArrayDeque<>();
        for (int i = 3; i < args.length; i++) {
            String[] c = args[i].split(":");
            Dep managed = bom.get(c[0] + ":" + c[1]);
            String v = c.length > 2 ? c[2] : managed == null ? null : managed.v();
            if (v == null) throw new IllegalStateException(args[i] + ": no version and not in the BOM " + args[2]);
            queue.add(new Node(c[0], c[1], v, Set.of()));
        }
        Set<String> seen = new HashSet<>();
        List<Path> jars = new ArrayList<>();
        while (!queue.isEmpty()) {
            Node n = queue.poll();
            if (!seen.add(n.g() + ":" + n.a())) continue; // nearest wins
            Model m = load(n.g(), n.a(), n.v());
            // Kotlin multiplatform root (kotlinx-coroutines-core): its jar is
            // metadata only, the JVM classes come from <artifact>-jvm.
            boolean kmpRoot = m.deps.stream().anyMatch(d -> d.g().equals(n.g()) && d.a().equals(n.a() + "-jvm"));
            if (!m.packaging.equals("pom") && !kmpRoot) jars.add(fetch(n.g(), n.a(), n.v(), "jar"));
            for (Dep d : m.deps) {
                Dep mm = m.managed.get(d.ga());
                String scope = d.scope() != null ? d.scope() : mm != null && mm.scope() != null ? mm.scope() : "compile";
                if (!scope.equals("compile") || d.optional() || d.classifier() != null) continue;
                if (!d.type().equals("jar")) continue;
                if (n.exclusions().contains(d.ga()) || n.exclusions().contains(d.g() + ":*")) continue;
                Dep pinned = bom.get(d.ga());
                String v = pinned != null ? pinned.v() : d.v() != null ? d.v() : mm != null ? mm.v() : null;
                if (v == null) throw new IllegalStateException(d.ga() + " (from " + n.a() + "): no version");
                if (v.startsWith("[") || v.startsWith("(")) throw new IllegalStateException(d.ga() + ": version range " + v);
                Set<String> ex = new HashSet<>(n.exclusions());
                ex.addAll(d.exclusions());
                queue.add(new Node(d.g(), d.a(), v, ex));
            }
        }
        for (Path jar : jars) System.out.println(jar);
    }

    static Model load(String g, String a, String v) throws Exception {
        String key = g + ":" + a + ":" + v;
        Model cached = MODELS.get(key);
        if (cached != null) return cached;
        var factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        Element project = factory.newDocumentBuilder().parse(fetch(g, a, v, "pom").toFile()).getDocumentElement();
        Model m = new Model();
        Element parent = child(project, "parent");
        Model p = parent == null ? null : load(text(parent, "groupId"), text(parent, "artifactId"), text(parent, "version"));
        if (p != null) m.props.putAll(p.props);
        m.g = Optional.ofNullable(text(project, "groupId")).orElse(p == null ? g : p.g);
        m.a = a;
        m.v = Optional.ofNullable(text(project, "version")).orElse(p == null ? v : p.v);
        if (text(project, "packaging") != null) m.packaging = text(project, "packaging");
        Element props = child(project, "properties");
        if (props != null) for (Element e : children(props)) m.props.put(e.getTagName(), e.getTextContent().trim());
        for (String prefix : new String[] {"project.", "pom.", ""}) {
            m.props.put(prefix + "groupId", m.g);
            m.props.put(prefix + "artifactId", m.a);
            m.props.put(prefix + "version", m.v);
        }
        if (p != null) { m.props.put("project.parent.version", p.v); m.props.put("parent.version", p.v); m.props.put("project.parent.groupId", p.g); }
        MODELS.put(key, m);
        if (p != null) { m.managed.putAll(p.managed); m.deps.addAll(p.deps); }
        List<Dep> imports = new ArrayList<>();
        Element dm = child(project, "dependencyManagement");
        for (Element e : children(child(dm, "dependencies"))) {
            Dep d = dep(m, e);
            if ("import".equals(d.scope())) imports.add(d); else m.managed.put(d.ga(), d);
        }
        for (Dep d : imports) for (var e : load(d.g(), d.a(), d.v()).managed.entrySet()) m.managed.putIfAbsent(e.getKey(), e.getValue());
        for (Element e : children(child(project, "dependencies"))) m.deps.add(dep(m, e));
        return m;
    }

    static Dep dep(Model m, Element e) {
        Set<String> ex = new HashSet<>();
        for (Element x : children(child(e, "exclusions"))) ex.add(i(m, text(x, "groupId")) + ":" + i(m, text(x, "artifactId")));
        String type = i(m, text(e, "type"));
        return new Dep(i(m, text(e, "groupId")), i(m, text(e, "artifactId")), i(m, text(e, "version")), i(m, text(e, "scope")),
            "true".equals(i(m, text(e, "optional"))), type == null ? "jar" : type, i(m, text(e, "classifier")), ex);
    }

    /** ${property} interpolation against the model's properties (with parents). */
    static String i(Model m, String s) {
        for (int round = 0; s != null && s.contains("${") && round < 10; round++) {
            var out = new StringBuilder();
            int pos = 0, start;
            while ((start = s.indexOf("${", pos)) >= 0) {
                int end = s.indexOf('}', start);
                if (end < 0) break;
                String name = s.substring(start + 2, end);
                out.append(s, pos, start).append(m.props.getOrDefault(name, "${" + name + "}"));
                pos = end + 1;
            }
            String next = out.append(s.substring(pos)).toString();
            if (next.equals(s)) break;
            s = next;
        }
        if (s != null && s.contains("${")) throw new IllegalStateException(m.g + ":" + m.a + ":" + m.v + ": unresolved " + s);
        return s;
    }

    /** Downloads into the cache once, verified against the repository's .sha1. */
    static Path fetch(String g, String a, String v, String ext) throws Exception {
        String rel = g.replace('.', '/') + "/" + a + "/" + v + "/" + a + "-" + v + "." + ext;
        Path target = cache.resolve(rel);
        if (Files.isRegularFile(target)) return target;
        byte[] body = get(repo + "/" + rel);
        String expected = new String(get(repo + "/" + rel + ".sha1")).trim().split("\\s+")[0];
        String actual = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(body));
        if (!actual.equalsIgnoreCase(expected)) throw new IllegalStateException("checksum mismatch: " + rel);
        Files.createDirectories(target.getParent());
        Path tmp = Files.createTempFile(target.getParent(), "dl", ".part");
        Files.write(tmp, body);
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        return target;
    }

    static byte[] get(String url) throws Exception {
        for (int attempt = 1; ; attempt++) {
            try {
                var r = HTTP.send(HttpRequest.newBuilder(URI.create(url)).build(), HttpResponse.BodyHandlers.ofByteArray());
                if (r.statusCode() == 200) return r.body();
                if (r.statusCode() == 404 || attempt == 3) throw new IOException("HTTP " + r.statusCode() + ": " + url);
            } catch (IOException e) {
                if (attempt == 3 || e.getMessage().startsWith("HTTP 404")) throw e;
            }
            Thread.sleep(1000L * attempt);
        }
    }

    static Element child(Element parent, String name) {
        if (parent == null) return null;
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling())
            if (n instanceof Element e && e.getTagName().equals(name)) return e;
        return null;
    }

    static List<Element> children(Element parent) {
        List<Element> out = new ArrayList<>();
        if (parent == null) return out;
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling()) if (n instanceof Element e) out.add(e);
        return out;
    }

    static String text(Element parent, String name) {
        Element e = child(parent, name);
        return e == null ? null : e.getTextContent().trim();
    }
}
JAVA
  local cp
  # shellcheck disable=SC2086 # COMPILE_ONLY is a word list
  cp=$(java "$src" "$MAVEN_REPOSITORY" "$CACHE_DIR/m2" \
    "org.springframework.boot:spring-boot-dependencies:$SPRING_BOOT_VERSION" $COMPILE_ONLY) \
    || fail "resolving the compileOnly dependencies failed"
  # kotlinc brings its own kotlin-stdlib
  echo "$cp" | grep -v '/org/jetbrains/kotlin/kotlin-stdlib' | paste -sd: -
}

# ---- lint, bundle -----------------------------------------------------------
cmd_lint() {
  need npx "Node 24"
  [ -f "$OPENAPI_SPEC" ] || fail "$OPENAPI_SPEC is missing."
  log "Redocly lint ($REDOCLY)"
  redocly lint "$OPENAPI_SPEC" --format=stylish
}

cmd_bundle() {
  need npx "Node 24"
  local raw=build/openapi/raw/openapi.yaml
  mkdir -p "$(dirname "$raw")" "$(dirname "$OPENAPI_BUNDLE")"
  redocly bundle "$OPENAPI_SPEC" -o "$raw" >build/openapi/bundle.log 2>&1 \
    || { cat build/openapi/bundle.log; fail "redocly bundle failed."; }
  # Version and Keycloak issuer into the bundle; the repository keeps
  # info.version 0.0.0 and the placeholder.
  VERSION="$VERSION" PLACEHOLDER="$KEYCLOAK_PLACEHOLDER" ISSUER="${KEYCLOAK_ISSUER%/}" \
    node - "$raw" "$OPENAPI_BUNDLE" <<'JS'
const fs = require('node:fs');
const [src, dst] = process.argv.slice(2);
let text = fs.readFileSync(src, 'utf8');
const line = /^  version: 0\.0\.0$/m;
if ((text.match(/^  version: 0\.0\.0$/gm) || []).length !== 1) {
  console.error("ERROR: expected exactly one 'info.version: 0.0.0' in the bundle."); process.exit(1);
}
text = text.replace(line, `  version: ${process.env.VERSION}`);
const placeholder = process.env.PLACEHOLDER;
if (placeholder) {
  if (!text.includes(placeholder)) { console.error(`ERROR: Keycloak placeholder ${placeholder} not in the bundle.`); process.exit(1); }
  text = text.split(placeholder).join(process.env.ISSUER);
}
fs.writeFileSync(dst, text);
JS
  log "Bundle $OPENAPI_BUNDLE - version $VERSION${KEYCLOAK_PLACEHOLDER:+, issuer ${KEYCLOAK_ISSUER%/}} ($(wc -l < "$OPENAPI_BUNDLE" | tr -d ' ') lines)"
}

# ---- breaking ---------------------------------------------------------------
cmd_breaking() {
  [ "$BREAKING_CHECK" = off ] && { log "breaking check: off"; return 0; }
  need git "breaking check"; need npx "Node 24"
  local last work oasdiff rep breaking declared opts
  last="${BASE_REF:-$(git describe --tags --abbrev=0 2>/dev/null || true)}"
  [ -n "$last" ] || { log "No tag yet - first release, nothing to compare."; return 0; }
  log "breaking check against $last (mode $BREAKING_CHECK)"
  oasdiff=$(oasdiff_bin)
  rep=$(abspath "$OASDIFF_REPORT_DIR"); mkdir -p "$rep"
  work=$(mktemp -d); TMP_DIRS="$TMP_DIRS $work"
  # Both sides unstamped: info.version is 0.0.0 on both.
  redocly bundle "$OPENAPI_SPEC" -o "$work/head.yaml" >"$work/bundle.log" 2>&1 \
    || { cat "$work/bundle.log"; fail "the contract does not bundle."; }
  # The tag's state through git archive, not git worktree (a worktree stays
  # registered in .git; the runner reuses .git, /tmp it does not).
  mkdir -p "$work/base"
  git archive "$last" | tar -x -C "$work/base"
  if ! (cd "$work/base" && npx --yes "$REDOCLY" bundle "$OPENAPI_SPEC" -o "$work/base.yaml") >"$work/bundle.log" 2>&1; then
    log "WARNING: $last does not bundle (different layout?) - no comparison."; return 0
  fi
  # Severity levels: defaults, then the repository's file (last line per rule wins).
  : > "$work/severity.in"
  local o
  for o in $OASDIFF_SEVERITY_OVERRIDES; do echo "${o%%:*} ${o#*:}" >> "$work/severity.in"; done
  if [ -n "$OASDIFF_SEVERITY_FILE" ] && [ -f "$OASDIFF_SEVERITY_FILE" ]; then
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$OASDIFF_SEVERITY_FILE" | grep -v '^[[:space:]]*$' >> "$work/severity.in" || true
  fi
  awk '{v[$1]=$2; if (!($1 in o)) {o[$1]=++n; k[n]=$1}} END {for (i=1;i<=n;i++) print k[i], v[k[i]]}' \
    "$work/severity.in" > "$rep/severity.txt"
  echo "Severity levels:"; sed 's/^/  /' "$rep/severity.txt"
  opts=(--severity-levels "$rep/severity.txt")
  if [ -n "$OASDIFF_IGNORE_FILE" ] && [ -f "$OASDIFF_IGNORE_FILE" ]; then
    echo "Ignored findings from $OASDIFF_IGNORE_FILE"; opts+=(--err-ignore "$OASDIFF_IGNORE_FILE")
  fi
  "$oasdiff" breaking "$work/base.yaml" "$work/head.yaml" "${opts[@]}" -f json > "$work/findings.json" || true
  set +e
  "$oasdiff" breaking "$work/base.yaml" "$work/head.yaml" "${opts[@]}" --fail-on ERR -f text > "$rep/oasdiff.txt"
  breaking=$?
  set -e
  cat "$rep/oasdiff.txt"
  [ "$breaking" -le 1 ] || fail "oasdiff failed (exit $breaking)."
  # Commits since the tag that declare a break ("feat!:", "BREAKING CHANGE:").
  git log --format='%h %s' -E --grep='^[a-z]+(\([^)]*\))?!:' --grep='^BREAKING[ -]CHANGE:' \
    "$last"..HEAD > "$work/declaring.txt"
  declared=false
  [ -s "$work/declaring.txt" ] && declared=true
  echo "breaking: $([ "$breaking" -eq 0 ] && echo no || echo yes), declared: $declared"
  [ "$declared" = true ] && sed 's/^/  declared by /' "$work/declaring.txt"
  junit_report "$work/findings.json" "$rep/oasdiff-junit.xml" "$last" "$declared" "$work/declaring.txt"
  if [ "$breaking" -ne 0 ] && [ "$declared" != true ]; then
    echo ""
    echo "The contract breaks (see above), but no commit since $last says so. Backend and"
    echo "frontend would get the break as a minor/patch update. Either make the change"
    echo "compatible or declare it: 'feat!: ...' or a footer 'BREAKING CHANGE: ...'."
    echo "A formal break without a change in behaviour: add the line to $OASDIFF_IGNORE_FILE."
    [ "$BREAKING_CHECK" = enforce ] && exit 1
    echo "(breaking check: warn - not failing)"
  fi
  if [ "$breaking" -eq 0 ] && [ "$declared" = true ]; then
    echo "Note: a commit declares a break, oasdiff finds none. Major anyway."
  fi
}

# junit_report <oasdiff json> <junit xml> <base ref> <declared> <declaring commits>
# The JUnit report (MR widget "Test summary") says what the job decided, not
# what oasdiff found: a breaking change fails only where it fails the job
# (not declared, BREAKING_CHECK=enforce); under warn it is skipped; declared
# it passes, with the finding and the declaring commits in system-out.
# Warnings and infos pass. One test case per finding, unique names (GitLab
# merges test cases of the same name). No finding: one passed test case.
junit_report() {
  BASE_REF="$3" DECLARED="$4" MODE="$BREAKING_CHECK" node - "$1" "$2" "$5" <<'JS'
const fs = require('node:fs');
const [src, dst, commitsFile] = process.argv.slice(2);
const { BASE_REF: base, DECLARED: declared, MODE: mode } = process.env;
let findings = [];
try { findings = JSON.parse(fs.readFileSync(src, 'utf8') || '[]') || []; } catch { findings = []; }
const commits = fs.readFileSync(commitsFile, 'utf8').trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const levels = { 3: 'error', 2: 'warning', 1: 'info' };
const seen = new Map();
let failures = 0, skipped = 0;
const cases = findings.map((f) => {
  let name = `${f.operation} ${f.path}: ${f.text}`;
  const n = (seen.get(name) || 0) + 1; seen.set(name, n);
  if (n > 1) name += ` (${n})`;
  const level = levels[f.level] || 'info';
  const detail = `[${f.id}] ${level} in ${f.operation} ${f.path}\n${f.text}`;
  let body;
  if (f.level !== 3) {
    body = `<system-out>${esc(`${detail}\n\nNot breaking (${level}).`)}</system-out>`;
  } else if (declared === 'true') {
    body = `<system-out>${esc(`${detail}\n\nBreaking change declared since ${base} by:\n${commits}`)}</system-out>`;
  } else if (mode === 'enforce') {
    failures++;
    body = `<failure message="${esc(`breaking change not declared by any commit since ${base}`)}">${esc(detail)}</failure>`;
  } else {
    skipped++;
    body = `<skipped message="${esc('breaking change not declared (breaking check: warn)')}"/><system-out>${esc(detail)}</system-out>`;
  }
  return `    <testcase classname="oasdiff.${esc(f.id)}" name="${esc(name)}" time="0">${body}</testcase>`;
});
if (cases.length === 0) {
  cases.push(`    <testcase classname="oasdiff" name="${esc(`no breaking change against ${base}`)}" time="0"></testcase>`);
}
fs.writeFileSync(dst, [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuites>',
  `  <testsuite name="${esc(`oasdiff breaking against ${base}`)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}" time="0">`,
  ...cases,
  '  </testsuite>',
  '</testsuites>',
  '',
].join('\n'));
JS
}

# ---- generate, check --------------------------------------------------------
cmd_generate() {
  need java "JDK 25"
  [ -f "$OPENAPI_BUNDLE" ] || cmd_bundle
  local gen; gen=$(generator_jar)
  local cfg=build/openapi/generator
  mkdir -p "$cfg"
  if [ "$KOTLIN" = true ]; then
    log "openapi-generator $OPENAPI_GENERATOR_VERSION: kotlin-spring"
    cat > "$cfg/kotlin-spring.json" <<EOF
{
  "packageName": "$API_BASE_PACKAGE",
  "basePackage": "$API_BASE_PACKAGE",
  "configPackage": "$API_BASE_PACKAGE.config",
  "useSpringBoot4": "true",
  "interfaceOnly": "true",
  "skipDefaultInterface": "true",
  "reactive": "$API_REACTIVE",
  "useFlowForArrayReturnType": "false",
  "useTags": "true",
  "requestMappingMode": "api_interface",
  "useResponseEntity": "true",
  "useBeanValidation": "true",
  "useSpringBuiltInValidation": "true",
  "documentationProvider": "none",
  "annotationLibrary": "swagger2",
  "exceptionHandler": "false",
  "gradleBuildFile": "false",
  "enumPropertyNaming": "UPPERCASE",
  "generateJsonIncludeAnnotations": "true",
  "generateJsonSetterNullsAnnotations": "false",
  "sourceFolder": "src/main/kotlin"
}
EOF
    # useSpringBoot4: jakarta + Spring 7 (implies Jackson 3). interfaceOnly +
    # skipDefaultInterface: the backend implements every route or does not
    # compile. useSpringBuiltInValidation: no class-level @Validated, Spring's
    # method validation answers 400. ApiUtil.kt is only used by default
    # interface bodies. "size" is a reserved word of the generator.
    rm -rf "$KOTLIN_GEN"
    java -jar "$gen" generate -g kotlin-spring -i "$OPENAPI_BUNDLE" -o "$KOTLIN_GEN" -c "$cfg/kotlin-spring.json" \
      --api-package "$API_BASE_PACKAGE.api" --model-package "$API_BASE_PACKAGE.model" \
      --global-property apiTests=false,modelTests=false,apiDocs=false,modelDocs=false \
      --openapi-generator-ignore-list '**/ApiUtil.kt' --name-mappings size=size \
      ${KOTLIN_TYPE_MAPPINGS:+--type-mappings "$KOTLIN_TYPE_MAPPINGS"} >"$cfg/kotlin-spring.log" 2>&1 \
      || { cat "$cfg/kotlin-spring.log"; fail "kotlin-spring generation failed."; }
  fi
  if [ "$TYPESCRIPT" = true ]; then
    log "openapi-generator $OPENAPI_GENERATOR_VERSION: typescript-angular"
    cat > "$cfg/typescript-angular.json" <<EOF
{
  "npmName": "$API_NPM_NAME",
  "npmVersion": "$VERSION",
  "ngVersion": "$NG_VERSION",
  "providedIn": "root",
  "fileNaming": "kebab-case",
  "useSingleRequestParameter": "true",
  "supportsES6": "true",
  "enumPropertyNaming": "UPPERCASE",
  "nullSafeAdditionalProps": "true"
}
EOF
    # enumPropertyNaming UPPERCASE: ErrorCode.VALIDATION_FAILED - the same
    # identifier on the wire, in Kotlin, in logs and as i18n key. stringEnums
    # stays false: an unknown code from a newer contract is just a string.
    rm -rf "$TS_GEN"
    java -jar "$gen" generate -g typescript-angular -i "$OPENAPI_BUNDLE" -o "$TS_GEN" -c "$cfg/typescript-angular.json" \
      --global-property apiTests=false,modelTests=false \
      --git-host "$GIT_HOST" --git-user-id "$GIT_USER_ID" --git-repo-id "$GIT_REPO_ID" >"$cfg/typescript-angular.log" 2>&1 \
      || { cat "$cfg/typescript-angular.log"; fail "typescript-angular generation failed."; }
  fi
}

# The hard rule: every model exactly once, named as in the schemas, no
# InlineObject, no *200Response, no Task1.
cmd_check() {
  need node "Node 24"
  [ -f "$MODEL_CHECK" ] || fail "$MODEL_CHECK is missing (model check)."
  local args=(--schemas "$SCHEMAS" --bundle "$OPENAPI_BUNDLE")
  [ "$KOTLIN" = true ] && args+=(--kotlin "$KOTLIN_GEN/src/main/kotlin/$(echo "$API_BASE_PACKAGE" | tr . /)/model")
  [ "$TYPESCRIPT" = true ] && args+=(--typescript "$TS_GEN/model")
  log "model check"
  node "$MODEL_CHECK" "${args[@]}"
}

# ---- Kotlin jar, sources jar, POM -------------------------------------------
cmd_kotlin() {
  need java "JDK 25"; need jar "JDK 25"
  local kh cp out=build/kotlin
  kh=$(kotlin_home)
  log "compileOnly dependencies (Spring Boot BOM $SPRING_BOOT_VERSION)"
  cp=$(compile_classpath)
  rm -rf "$out" && mkdir -p "$out/classes" "$out/resources/$(dirname "$SPEC_RESOURCE")" build/libs
  log "kotlinc $KOTLIN_VERSION (JVM target $JVM_TARGET)"
  # -Xannotation-default-target: silences "annotation is currently applied to
  # the value parameter only" for the generated @Schema annotations.
  # allopen preset spring = plugin.spring: the generated @Configuration is open.
  "$kh/bin/kotlinc" -jvm-target "$JVM_TARGET" -module-name "$ARTIFACT" -no-reflect \
    -Xjsr305=strict -Xannotation-default-target=param-property ${KOTLIN_OPT_IN:+-opt-in="$KOTLIN_OPT_IN"} \
    -Xplugin="$kh/lib/allopen-compiler-plugin.jar" -P plugin:org.jetbrains.kotlin.allopen:preset=spring \
    -classpath "$cp" -d "$out/classes" "$KOTLIN_GEN/src/main/kotlin" \
    || fail "kotlinc failed."
  # The bundle travels inside the jar. META-INF/resources/ is a static resource
  # location of Spring Boot: every service with the jar serves the contract at
  # /openapi/<API_NAME>.yaml.
  cp "$OPENAPI_BUNDLE" "$out/resources/$SPEC_RESOURCE"
  printf 'Implementation-Title: %s\nImplementation-Version: %s\nOpenAPI-Spec: %s\n' \
    "$API_NAME" "$VERSION" "$SPEC_RESOURCE" > "$out/MANIFEST.MF"
  local jarfile="build/libs/$ARTIFACT-$VERSION.jar" srcjar="build/libs/$ARTIFACT-$VERSION-sources.jar"
  rm -f build/libs/"$ARTIFACT"-*.jar
  # fixed timestamps like Gradle's reproducible archives
  jar --create --file "$jarfile" --manifest "$out/MANIFEST.MF" --date=1980-02-01T00:00:00Z \
    -C "$out/classes" . -C "$out/resources" .
  jar --create --file "$srcjar" --date=1980-02-01T00:00:00Z -C "$KOTLIN_GEN/src/main/kotlin" .

  # Maven layout as maven-publish wrote it: jar, sources, POM, checksums and
  # maven-metadata.xml. No .module (Gradle metadata) - the POM therefore has
  # no "published-with-gradle-metadata" marker.
  local dir; dir="$MAVEN_STAGING_DIR/$(echo "$API_GROUP" | tr . /)/$ARTIFACT"
  rm -rf "$dir/$VERSION" && mkdir -p "$dir/$VERSION"
  cp "$jarfile" "$dir/$VERSION/$ARTIFACT-$VERSION.jar"
  cp "$srcjar" "$dir/$VERSION/$ARTIFACT-$VERSION-sources.jar"
  cat > "$dir/$VERSION/$ARTIFACT-$VERSION.pom" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <modelVersion>4.0.0</modelVersion>
  <groupId>$API_GROUP</groupId>
  <artifactId>$ARTIFACT</artifactId>
  <version>$VERSION</version>
  <name>$ARTIFACT</name>
  <description>$API_DESCRIPTION; bundled spec at $SPEC_RESOURCE.</description>
  <dependencies>
    <dependency>
      <groupId>org.jetbrains.kotlin</groupId>
      <artifactId>kotlin-stdlib</artifactId>
      <version>$KOTLIN_VERSION</version>
      <scope>compile</scope>
    </dependency>
  </dependencies>
</project>
EOF
  cat > "$dir/maven-metadata.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>$API_GROUP</groupId>
  <artifactId>$ARTIFACT</artifactId>
  <versioning>
    <latest>$VERSION</latest>
    <release>$VERSION</release>
    <versions>
      <version>$VERSION</version>
    </versions>
    <lastUpdated>$(date -u +%Y%m%d%H%M%S)</lastUpdated>
  </versioning>
</metadata>
EOF
  local f h
  for f in "$dir/$VERSION"/* "$dir/maven-metadata.xml"; do
    for h in md5 sha1 sha256 sha512; do digest "$h" "$f" | tr -d '\n' > "$f.$h"; done
  done
  log "Maven publication in $MAVEN_STAGING_DIR:"
  (cd "$MAVEN_STAGING_DIR" && find . -type f ! -name '*.md5' ! -name '*.sha*' | sed 's|^\./|  |' | sort)
}

# ---- npm package ------------------------------------------------------------
cmd_npm() {
  need npm "Node 24"
  log "ng-packagr ($TS_GEN)"
  # The generated package.json has "prepare": "npm run build", so install
  # alone runs ng-packagr. A freshly generated project has no lock file.
  (cd "$TS_GEN" && npm install --no-audit --no-fund --loglevel=error) || fail "npm install / ng-packagr failed."
  local dest; dest=$(abspath "$NPM_PACKAGE_DIR")
  rm -rf "$dest" && mkdir -p "$dest"
  (cd "$TS_GEN/dist" && npm pack --pack-destination "$dest" --loglevel=error >/dev/null)
  log "npm package: $(cd "$dest" && ls ./*.tgz | sed 's|^\./||')"
}

# ---- composite commands -----------------------------------------------------
cmd_build() {
  cmd_bundle
  cmd_generate
  cmd_check            # nothing compiles from a contract that fails the check
  [ "$KOTLIN" = true ] && cmd_kotlin
  [ "$TYPESCRIPT" = true ] && cmd_npm
  log "build $VERSION done."
}

cmd_install() {
  cmd_build
  [ "$KOTLIN" = true ] || return 0
  local rel; rel="$(echo "$API_GROUP" | tr . /)/$ARTIFACT/$VERSION"
  mkdir -p "$HOME/.m2/repository/$rel"
  cp "$MAVEN_STAGING_DIR/$rel/"* "$HOME/.m2/repository/$rel/"
  log "installed into ~/.m2/repository/$rel"
}

case "${1:-}" in
  lint)     cmd_lint ;;
  bundle)   cmd_bundle ;;
  breaking) cmd_breaking ;;
  generate) cmd_bundle; cmd_generate ;;
  check)    cmd_bundle; cmd_generate; cmd_check ;;
  build)    cmd_build ;;
  all)      cmd_lint; cmd_breaking; cmd_build ;;
  install)  cmd_install ;;
  clean)    rm -rf build ;;
  *) sed -n '2,/^# ====/p' "$0" | sed -n '/^#   lint/,/^#   clean/p' | sed 's/^# \{0,1\}//'
     echo "usage: $0 lint|bundle|breaking|build|all|generate|check|install|clean"; exit 2 ;;
esac
