package at.dergeorg.drawboard.shared.context

/** Who is acting: a signed-in user, a scheduled/system job, or nobody (anonymous). */
data class Actor(val type: ActorType, val id: String?) {
    companion object {
        val ANONYMOUS = Actor(ActorType.ANONYMOUS, null)

        fun user(id: String) = Actor(ActorType.USER, id)

        fun system(name: String) = Actor(ActorType.SYSTEM, name)
    }
}

enum class ActorType { USER, SYSTEM, ANONYMOUS }

/** Everything cross-cutting about the current request or job. */
data class RequestContext(val actor: Actor, val requestId: String?, val traceId: String?)
