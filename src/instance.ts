import { config } from "./helpers/config";
import { Browser } from "./services/browser";
import { Page } from "./services/page";
import { Search } from "./services/search";

// Every shared service instance is created here, once, and imported where it is used.
export const browser = new Browser(config);

// Website search answers from the search backend over HTTP; it does not touch the browser.
export const searchService = new Search(config);

export const page = new Page(browser, config);
