// Errors the HTTP layer turns into status codes. Anything else is a bug and answers 500.

/** The record the request names doesn't exist. 404. */
export class NotFoundError extends Error {}

/** The request conflicts with the office's records, such as a name already in use. 409. */
export class ConflictError extends Error {}

/** The request can't be carried out as given, such as an approval without the file it needs. 400. */
export class InvalidRequestError extends Error {}
