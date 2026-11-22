package at.dergeorg.drawboard.planning.domain.common

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.uuid.Uuid

/**
 * One mutex per key, from a fixed set (two keys may share one - harmless): the writes to one round, session or board run
 * one after the other, so the caps and the version hold without database locks. One replica only, like every other counter of the
 * application. Every kind of key needs its own instance; never hold two locks of one instance at once, and take the board lock
 * before the session lock.
 */
internal class KeyedLocks(private val stripes: Int = STRIPES) {

    private val locks = Array(stripes) { Mutex() }

    suspend fun <T> withLock(key: Uuid,
        block: suspend () -> T): T = locks[(key.hashCode() and Int.MAX_VALUE) % stripes].withLock { block() }

    private companion object {
        const val STRIPES = 256
    }
}
