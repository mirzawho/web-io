import { requireToken } from "./auth";
import { cache } from "./cache";
import { validate } from "./validate";

/** Imported as one object so a route reads as `middlewares.validate(schema)`. */
export default { auth: requireToken, validate, cache };