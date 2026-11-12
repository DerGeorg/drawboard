import { Service } from '@angular/core';
import { ErrorCode } from '@apps/drawboard-api';

import { ClientErrorCode, Problem } from '../util/api-error';

/**
 * User-facing text per ErrorCode, `{name}` placeholders filled from `params`.
 * Partial on purpose: a code this build does not know falls back to the server's detail/title,
 * so a new backend code never breaks the UI. i18n hook: swap this map (keys are the codes).
 */
const MESSAGES: Partial<Record<ErrorCode | ClientErrorCode, string>> = {
  VALIDATION_FAILED: 'Some fields are invalid. Please check your input.',
  MALFORMED_REQUEST: 'The request could not be processed.',
  UNAUTHORIZED: 'Your session has expired. Please sign in again.',
  FORBIDDEN: 'You do not have permission for this action.',
  NOT_FOUND: 'The requested item does not exist.',
  CONFLICT: 'Someone else changed this item in the meantime. Reload it and try again.',
  INTERNAL_ERROR: 'Something went wrong on our side.',
  BAD_GATEWAY: 'The server is not reachable right now. Please try again in a moment.',
  GATEWAY_TIMEOUT: 'The server took too long to answer. Please try again.',
  LIBRARY_BOARD_NOT_FOUND: 'This board does not exist (any more).',
  LIBRARY_BOARD_ACCESS_DENIED: 'You do not have access to this board.',
  LIBRARY_FOLDER_NOT_FOUND: 'This folder does not exist (any more).',
  LIBRARY_FOLDER_CYCLE: 'A folder cannot be moved into itself or into a folder below it.',
  LIBRARY_USER_NOT_FOUND: 'This person has not signed in to Drawboard yet.',
  LIBRARY_SHARE_NOT_FOUND: 'This link is invalid, expired or was revoked.',
  LIBRARY_SHARE_LOGIN_REQUIRED: 'Please sign in to open this link.',
  LIBRARY_SHARE_PASSWORD_REQUIRED: 'This link needs a password.',
  LIBRARY_SHARE_PASSWORD_INVALID: 'The password is wrong.',
  COLLAB_VERSION_NOT_FOUND: 'This version does not exist (any more).',
  PAYLOAD_TOO_LARGE: 'The file is too large.',
  UNSUPPORTED_MEDIA_TYPE: 'This kind of file is not accepted.',
  FILES_FILE_NOT_FOUND: 'This file does not exist (any more).',
  FILES_TYPE_NOT_ALLOWED:
    'This file type is not allowed. Use images (PNG, JPEG, GIF, WebP), videos (MP4, WebM), PDF or Office files.',
  FILES_QUOTA_EXCEEDED: 'There is no room for this file: the storage quota is used up.',
  FILES_URL_INVALID: 'The file link has expired. Reload the board.',
  PLUGINS_PLUGIN_NOT_FOUND: 'This plugin is not installed (any more).',
  PLUGINS_ARCHIVE_INVALID: 'The plugin ZIP is not valid ({reason}).',
  PLUGINS_MANIFEST_INVALID: 'The plugin manifest is not valid.',
  PLUGINS_VERSION_EXISTS:
    'Version {installedVersion} of this plugin is installed: upload a higher version.',
  PLUGINS_CAPABILITY_NOT_REQUESTED: 'The plugin does not request the capability {capability}.',
  PLANNING_ROUND_NOT_FOUND: 'This estimation round does not exist (any more).',
  PLANNING_ROUND_ALREADY_OPEN: 'An estimation round is already open on this story card.',
  PLANNING_ROUND_LIMIT_REACHED:
    'This board already has {limit} open estimation rounds. Reveal or cancel one first.',
  PLANNING_ROUND_CLOSED: 'This estimation round has ended.',
  PLANNING_ROUND_FULL: 'This estimation round is full ({limit} participants).',
  PLANNING_VALUE_INVALID: 'This value is not a card of the round.',
  TOO_MANY_REQUESTS: 'Too many requests. Please wait a moment and try again.',
  CLIENT_NETWORK_ERROR: 'The server cannot be reached. Check your connection.',
  CLIENT_UNEXPECTED_RESPONSE: 'The server answered unexpectedly.',
};

@Service()
export class ErrorMessages {
  text(problem: Problem): string {
    const template = (MESSAGES as Readonly<Record<string, string | undefined>>)[problem.code];
    if (template) {
      return template.replace(
        /\{(\w+)\}/g,
        (match, name: string) => problem.params?.[name] ?? match,
      );
    }
    return problem.detail ?? problem.title;
  }
}
