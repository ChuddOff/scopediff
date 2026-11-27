import { apiBaseUrl } from "./api/config";
import { createHttpApi } from "./api/http";
import { startApp } from "./start-app";

startApp(createHttpApi(apiBaseUrl));
