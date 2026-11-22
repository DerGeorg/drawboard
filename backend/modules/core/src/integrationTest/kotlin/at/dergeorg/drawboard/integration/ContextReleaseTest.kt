package at.dergeorg.drawboard.integration

import org.junit.jupiter.api.Test
import org.springframework.context.support.GenericApplicationContext
import reactor.netty.http.HttpResources
import java.util.function.Supplier
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** [ContextRelease] on plain contexts: what has to be gone after Spring's context cache closed a test context. */
class ContextReleaseTest {

    @Test
    fun `when a context closes then its stopped child closes too and the global client resources are disposed`() {
        val parent = GenericApplicationContext()
        parent.registerBean(ContextRelease::class.java, Supplier { ContextRelease(parent) })
        parent.refresh()
        val child = GenericApplicationContext().apply {
            setParent(parent)
            refresh()
        }
        child.stop() // what a pause of the cached parent does to the management child
        val resources = HttpResources.get()

        parent.close()

        assertFalse(child.isActive, "the child is closed with its parent, although it was stopped")
        assertTrue(resources.isDisposed, "the connection pools of the test clients are gone")
    }
}
