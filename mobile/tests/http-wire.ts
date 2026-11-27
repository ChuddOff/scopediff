import { createHttpApi } from "../api/http";
import { startApp } from "../start-app";

const base = "https://scope-diff.invalid/api/v1";
startApp(createHttpApi(base, {
  request: (url, options) => fetch(url.replace(base, "http://127.0.0.1:49335/api/v1"), options),
}));
