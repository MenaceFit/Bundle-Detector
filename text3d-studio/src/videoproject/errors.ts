/**
 * Turns an error crossing the Electron IPC boundary into something a person can
 * act on.
 *
 * Electron wraps anything thrown in the main process as
 * `Error invoking remote method 'channel': Error: <real message>`. That prefix
 * says nothing to the user and buries the part that matters, so it is stripped
 * before the message ever reaches a notification.
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const NESTED_ERROR = /^(?:Error|TypeError|RangeError):\s*/;

export function humanizeError(error: unknown): string {
  let message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);

  message = message.replace(IPC_PREFIX, '');
  // The wrapper often leaves a second "Error: " behind it.
  while (NESTED_ERROR.test(message)) {
    message = message.replace(NESTED_ERROR, '');
  }

  return message.trim().length > 0 ? message.trim() : "Une erreur inattendue s'est produite.";
}
