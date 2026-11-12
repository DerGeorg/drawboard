package at.dergeorg.drawboard.core.infra.web

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.nio.file.Files
import java.nio.file.Path
import kotlin.time.Clock

@Configuration(proxyBeanMethods = false)
internal class UploadConfiguration {

    @Bean
    fun uploadGuard(properties: UploadProperties, clock: Clock) = UploadGuard(properties, clock)

    /**
     * The directory Spring spools multipart parts to (`DRAWBOARD_UPLOAD_SPOOL_DIR`, default: the JVM's temp directory). It is
     * created and tested for writing at the start, and what an earlier run left in it is removed - nothing can be in flight
     * yet - so a crash does not fill the volume over time.
     */
    @Bean
    fun uploadSpoolDirectory(@Value("\${spring.webflux.multipart.file-storage-directory}") directory: String): SpoolDirectory =
        SpoolDirectory.prepare(Path.of(directory))
}

/** The prepared spool directory. */
internal class SpoolDirectory private constructor(val path: Path) {

    /** The temp files of parts that are still on disk. */
    fun leftovers(): List<Path> = Files.list(path).use { files ->
        files.filter { it.fileName.toString().startsWith(PREFIX) && it.fileName.toString().endsWith(SUFFIX) }.toList()
    }

    companion object {
        /** The names Spring's multipart reader gives its temp files (`Files.createTempFile(dir, "spring-multipart", ".multipart")`). */
        const val PREFIX = "spring-multipart"
        const val SUFFIX = ".multipart"

        fun prepare(path: Path): SpoolDirectory {
            Files.createDirectories(path)
            require(Files.isDirectory(path) && Files.isWritable(path)) { "DRAWBOARD_UPLOAD_SPOOL_DIR $path is not a writable directory" }
            return SpoolDirectory(path).also { it.leftovers().forEach(Files::deleteIfExists) }
        }
    }
}
