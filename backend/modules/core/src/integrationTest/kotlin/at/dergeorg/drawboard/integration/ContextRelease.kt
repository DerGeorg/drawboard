package at.dergeorg.drawboard.integration

import org.springframework.beans.factory.DisposableBean
import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.context.ApplicationContext
import org.springframework.context.ApplicationListener
import org.springframework.context.ConfigurableApplicationContext
import org.springframework.context.annotation.Bean
import org.springframework.context.event.ContextRefreshedEvent
import reactor.netty.http.HttpResources
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Lets the garbage collector have a test application context once Spring's context cache has closed it (the cache
 * holds at most `spring.test.context.cache.maxSize` contexts, see spring.properties). Registered for every test context
 * of this source set by META-INF/spring/...AutoConfiguration.imports; the application itself never sees it.
 */
@AutoConfiguration
class ContextReleaseAutoConfiguration {

    @Bean
    fun contextRelease(context: ApplicationContext): ContextRelease = ContextRelease(context)
}

/**
 * Two things kept every closed test context reachable, so the context cache could evict as much as it liked and the
 * heap of the test JVM still grew with every context configuration until a test died of OutOfMemoryError:
 *
 * - The management child context (`management.server.port`): Boot's ChildManagementContextInitializer closes it with
 *   the parent only while the child still runs - but Spring 7 pauses an idle cached context, which stops the child
 *   first. The child stayed open, with a reference to its closed parent. Here every child is closed with its parent.
 * - Reactor Netty's global client resources: WebTestClient (and every client built with `bindToServer()`) connects
 *   through them, one connection pool per server port, and the pool keeps the client's codecs - with the context's
 *   JsonMapper and through it the bean factory. In tests nothing ever disposes them (Boot gives every test context its
 *   own server resources so that closing one does not stop the others). Disposed here when a context closes - the test
 *   classes run one after another, so no request is in flight - and created again by the next client that connects.
 */
class ContextRelease(private val context: ApplicationContext) : ApplicationListener<ContextRefreshedEvent>, DisposableBean {

    private val children = CopyOnWriteArrayList<ConfigurableApplicationContext>()

    /** A child's events reach its parent too: this is how the management context shows up here. */
    override fun onApplicationEvent(event: ContextRefreshedEvent) {
        val refreshed = event.applicationContext
        if (refreshed.parent === context && refreshed is ConfigurableApplicationContext) children += refreshed
    }

    override fun destroy() {
        children.forEach { it.close() }
        children.clear()
        HttpResources.disposeLoopsAndConnections()
    }
}
