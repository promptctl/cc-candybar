import { noProject } from "../../src/config/dsl-loader";
import { systemFilesystem } from "../../src/disk/system-filesystem";
import { HOST } from "./host";

// A load with no session and nothing beneath the bundled default, reading the
// test's own disk.
export const NO_PROJECT = noProject(systemFilesystem, HOST.home);
