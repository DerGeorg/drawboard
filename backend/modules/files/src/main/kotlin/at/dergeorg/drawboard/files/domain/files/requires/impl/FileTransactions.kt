package at.dergeorg.drawboard.files.domain.files.requires.impl

import at.dergeorg.drawboard.files.domain.files.requires.Transactions
import org.springframework.stereotype.Component
import org.springframework.transaction.reactive.TransactionalOperator
import org.springframework.transaction.reactive.executeAndAwait

/** The [Transactions] port on the reactive transaction manager: REQUIRED, like `@Transactional`. */
@Component
internal class FileTransactions(private val operator: TransactionalOperator) : Transactions {

    override suspend fun <T> required(block: suspend () -> T): T = operator.executeAndAwait { block() } as T
}
