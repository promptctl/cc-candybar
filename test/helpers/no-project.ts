import { noProject } from "../../src/config/dsl-loader";
import { HOST } from "./host";

// A load with no session and nothing beneath the bundled default.
export const NO_PROJECT = noProject(HOST.home);
