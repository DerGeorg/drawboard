package at.dergeorg.drawboard.integration.planning

import at.dergeorg.drawboard.contract.model.EstimationEntry
import at.dergeorg.drawboard.contract.model.EstimationSession
import at.dergeorg.drawboard.contract.model.EstimationSessionList
import tools.jackson.databind.json.JsonMapper

/** Reads the bodies of the estimation answers (the poker [Reply] keeps its mapper to itself). */
class EstimationJson(private val json: JsonMapper) {

    fun session(reply: Reply): EstimationSession = json.readValue(reply.body, EstimationSession::class.java)

    fun sessions(reply: Reply): EstimationSessionList = json.readValue(reply.body, EstimationSessionList::class.java)

    fun entry(reply: Reply): EstimationEntry = json.readValue(reply.body, EstimationEntry::class.java)

    /** The items of an answer as plain JSON trees, for comparing what an answer says about each card (E3). */
    fun itemTrees(reply: Reply): List<Map<String, Any?>> {
        @Suppress("UNCHECKED_CAST")
        val tree = json.readValue(reply.body, Map::class.java) as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        return tree["items"] as List<Map<String, Any?>>
    }
}
