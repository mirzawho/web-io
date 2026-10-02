import { cache } from "./cache";
import { validate } from "./validate";

/** Imported as one object so a route reads as `middlewares.validate(schema)`. */
export default { validate, cache };
