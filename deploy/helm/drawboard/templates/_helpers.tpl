{{/* Names */}}
{{- define "drawboard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "drawboard.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Component names: call with (dict "ctx" . "component" "backend") */}}
{{- define "drawboard.componentName" -}}
{{- printf "%s-%s" (include "drawboard.fullname" .ctx) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "drawboard.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Version label: the image tag of the component (backend and frontend are released separately) */}}
{{- define "drawboard.version" -}}
{{- $v := .ctx.Chart.AppVersion -}}
{{- if eq .component "backend" -}}{{- $v = default $v .ctx.Values.backend.image.tag -}}
{{- else if eq .component "frontend" -}}{{- $v = default $v .ctx.Values.frontend.image.tag -}}
{{- else if eq .component "gotenberg" -}}{{- $v = default $v .ctx.Values.gotenberg.image.tag -}}
{{- end -}}
{{- $v -}}
{{- end -}}

{{/* Labels */}}
{{- define "drawboard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "drawboard.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "drawboard.labels" -}}
helm.sh/chart: {{ include "drawboard.chart" .ctx }}
{{ include "drawboard.selectorLabels" . }}
app.kubernetes.io/version: {{ include "drawboard.version" . | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
app.kubernetes.io/part-of: drawboard
{{- end -}}

{{/* Labels that select every pod of this release (default-deny policy) */}}
{{- define "drawboard.instanceLabels" -}}
app.kubernetes.io/name: {{ include "drawboard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Image: call with (dict "ctx" . "image" .Values.backend.image) */}}
{{- define "drawboard.image" -}}
{{- printf "%s:%s" .image.repository (default .ctx.Chart.AppVersion .image.tag) -}}
{{- end -}}

{{/*
S7.8/S7.9 hardening of a pod, call with (dict "uid" 10001 "gid" 10001).
Pod level: non-root user, fsGroup (writable emptyDirs), RuntimeDefault seccomp.
*/}}
{{- define "drawboard.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .gid }}
fsGroup: {{ .gid }}
fsGroupChangePolicy: OnRootMismatch
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Container level; the root file system is always read-only, writable paths are emptyDirs. */}}
{{- define "drawboard.containerSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .gid }}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
privileged: false
capabilities:
  drop:
    - ALL
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Scheduling knobs, call with the component's values */}}
{{- define "drawboard.scheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Database settings, resolved for the built-in or the external PostgreSQL */}}
{{- define "drawboard.db.host" -}}
{{- if .Values.postgresql.enabled -}}
{{- include "drawboard.componentName" (dict "ctx" . "component" "postgresql") -}}
{{- else -}}
{{- required "postgresql.external.host is required when postgresql.enabled=false" .Values.postgresql.external.host -}}
{{- end -}}
{{- end -}}

{{- define "drawboard.db.port" -}}
{{- if .Values.postgresql.enabled -}}5432{{- else -}}{{ .Values.postgresql.external.port }}{{- end -}}
{{- end -}}

{{- define "drawboard.db.name" -}}
{{- if .Values.postgresql.enabled -}}{{ .Values.postgresql.auth.database }}{{- else -}}{{ required "postgresql.external.database is required" .Values.postgresql.external.database }}{{- end -}}
{{- end -}}

{{- define "drawboard.db.user" -}}
{{- if .Values.postgresql.enabled -}}{{ .Values.postgresql.auth.username }}{{- else -}}{{ required "postgresql.external.user is required" .Values.postgresql.external.user }}{{- end -}}
{{- end -}}

{{- define "drawboard.db.secretName" -}}
{{- if .Values.postgresql.enabled -}}
{{- required "postgresql.auth.existingSecret is required (kubectl create secret generic ... --from-literal=password=...)" .Values.postgresql.auth.existingSecret -}}
{{- else -}}
{{- required "postgresql.external.existingSecret is required (kubectl create secret generic ... --from-literal=password=...)" .Values.postgresql.external.existingSecret -}}
{{- end -}}
{{- end -}}

{{- define "drawboard.db.secretKey" -}}
{{- if .Values.postgresql.enabled -}}{{ .Values.postgresql.auth.passwordKey }}{{- else -}}{{ .Values.postgresql.external.passwordKey }}{{- end -}}
{{- end -}}

{{/* Name of the Secret that holds the key files of the backend */}}
{{- define "drawboard.secretName" -}}
{{- if .Values.secrets.existingSecret -}}{{ .Values.secrets.existingSecret }}{{- else -}}{{ include "drawboard.fullname" . }}-keys{{- end -}}
{{- end -}}

{{/* DRAWBOARD_TRUSTED_PROXIES: a list or a comma separated string */}}
{{- define "drawboard.trustedProxies" -}}
{{- if kindIs "string" .Values.trustedProxies -}}{{ .Values.trustedProxies }}{{- else -}}{{ join "," .Values.trustedProxies }}{{- end -}}
{{- end -}}

{{/* Public URL must carry the host of the Ingress, otherwise the WebSocket Origin check (S2.2) fails */}}
{{- define "drawboard.validate" -}}
{{- $_ := required "publicUrl is required (the browser origin, e.g. https://draw.example.org; the WebSocket handshake accepts exactly this Origin)" .Values.publicUrl -}}
{{- $_ := required "oidc.issuerUri is required" .Values.oidc.issuerUri -}}
{{- $_ := required "oidc.audience is required (without it tokens issued for other clients would be accepted, S6.2)" .Values.oidc.audience -}}
{{- if eq .Values.oidc.audience .Values.frontend.oidc.clientId -}}
{{- fail "oidc.audience must never equal frontend.oidc.clientId, otherwise ID tokens would pass as access tokens (S6.2)" -}}
{{- end -}}
{{- if .Values.ingress.enabled -}}
{{- $host := required "ingress.host is required when ingress.enabled=true" .Values.ingress.host -}}
{{- if not (contains (printf "://%s" $host) .Values.publicUrl) -}}
{{- fail (printf "publicUrl (%s) must contain the ingress host (%s), otherwise the WebSocket Origin check fails" .Values.publicUrl $host) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.secrets.existingSecret .Values.secrets.create -}}
{{- fail "secrets.existingSecret and secrets.create are exclusive" -}}
{{- end -}}
{{- if .Values.secrets.create -}}
{{- $fu := required "secrets.create=true needs secrets.values.fileUrlKeys (head -c 32 /dev/urandom | base64)" .Values.secrets.values.fileUrlKeys -}}
{{- $pp := required "secrets.create=true needs secrets.values.pluginPseudonymKey (head -c 32 /dev/urandom | base64)" .Values.secrets.values.pluginPseudonymKey -}}
{{- if eq (trim $fu) (trim $pp) -}}
{{- fail "secrets.values.fileUrlKeys and pluginPseudonymKey must differ: the pseudonym key is a secret of its own (S3.8)" -}}
{{- end -}}
{{- if .Values.guests.enabled -}}
{{- $_ := required "guests.enabled=true needs secrets.values.guestSigningKeys (EC P-256, PKCS#8 PEM, S1.5)" .Values.secrets.values.guestSigningKeys -}}
{{- end -}}
{{- else if not .Values.secrets.existingSecret -}}
{{- fail "set secrets.existingSecret (a Secret with the keys file_url_keys and plugin_pseudonym_key, plus guest_signing_keys for guests; see README Install) or secrets.create=true with secrets.values.*" -}}
{{- end -}}
{{- if and .Values.clamav.host .Values.clamav.failClosed -}}
{{- $cap := int64 (default 524288000 (index .Values.backend.files "FILES_MAX_VIDEO_BYTES")) -}}
{{- if lt (int64 (default 0 .Values.clamav.maxBytes)) $cap -}}
{{- fail (printf "clamav.failClosed=true needs clamav.maxBytes >= the video cap (%d bytes), otherwise no video can be uploaded; clamd's StreamMaxLength, MaxFileSize and MaxScanSize must be at least that too" $cap) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.clamav.failClosed (not .Values.clamav.host) -}}
{{- fail "clamav.failClosed=true needs clamav.host" -}}
{{- end -}}
{{- end -}}
