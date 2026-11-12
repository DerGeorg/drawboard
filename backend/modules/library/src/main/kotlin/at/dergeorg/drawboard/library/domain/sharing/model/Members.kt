package at.dergeorg.drawboard.library.domain.sharing.model

import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.folders.model.FolderView
import kotlin.uuid.Uuid

/** A grant that applies to a resource; [inheritedFrom] is the folder it is set on, null when set on the resource itself. */
data class MemberEntry(val grant: Grant, val inheritedFrom: Uuid?)

/** Who has access to a resource: its owner and everybody granted. Display names are the caller's business (module users). */
data class MembersView(val ownerId: Uuid, val members: List<MemberEntry>)

/** What others shared with a user directly (user, group and remembered link grants). */
data class SharedView(val boards: List<BoardView>, val folders: List<FolderView>)
