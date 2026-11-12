package at.dergeorg.drawboard.files.infra

import at.dergeorg.drawboard.files.domain.files.InMemoryFileRepository
import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.FileKind
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.ObjectProvider
import kotlin.test.assertEquals
import kotlin.uuid.Uuid

class FilesMetricsTest {

    private val registry = SimpleMeterRegistry()
    private val provider = mockk<ObjectProvider<MeterRegistry>> {
        every { getObject() } returns registry
        every { ifAvailable } returns registry
    }

    @Test
    fun `when uploads and conversions are reported then the counters carry only the result as tag`() {
        val metrics = MicrometerFilesMetrics(provider)

        metrics.upload("accepted")
        metrics.upload("accepted")
        metrics.upload("quota_exceeded")
        metrics.conversion("done")
        metrics.conversion("failed")

        assertEquals(2.0, registry.get("drawboard.uploads").tag("result", "accepted").counter().count(), "accepted")
        assertEquals(1.0, registry.get("drawboard.uploads").tag("result", "quota_exceeded").counter().count(), "refused")
        assertEquals(1.0, registry.get("drawboard.conversions").tag("result", "done").counter().count(), "done")
        assertEquals(1.0, registry.get("drawboard.conversions").tag("result", "failed").counter().count(), "failed")
        val labels = registry.meters.flatMap { m -> m.id.tags.map { it.key } }.toSet()
        assertEquals(setOf("result"), labels, "no file, board or user in a label")
    }

    @Test
    fun `when the storage is read then the gauge drawboard_storage_bytes with kind files shows originals plus PDFs`() = runTest {
        val repository = InMemoryFileRepository()
        fun file(size: Long, pdf: Long?) = StoredFile(
            id = Uuid.generateV7(), boardId = Uuid.generateV7(), name = "a.docx", mediaType = "application/pdf", kind = FileKind.DOCUMENT,
            size = size, createdAt = FIXED_NOW, createdBy = Uuid.generateV7(), conversion = Conversion.NONE, pdfSize = pdf,
        )
        repository.insert(file(100, 40))
        repository.insert(file(10, null))

        FilesStorageGauge(repository, provider, RecordingAppLogger()).refresh()

        assertEquals(150.0, registry.get("drawboard.storage.bytes").tag("kind", "files").gauge().value(), "100 + 40 + 10")
    }
}
