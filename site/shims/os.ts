// node:os in the page: the simulated machine the fixture describes.
export const HOME = "/home/demo";
export const homedir = (): string => HOME;
export const tmpdir = (): string => "/tmp";
export const platform = (): string => "linux";
export const hostname = (): string => "demo";
export const userInfo = () => ({ username: "demo", uid: 1000, gid: 1000, homedir: HOME, shell: "/bin/zsh" });
export const EOL = "\n";
export const cpus = () => [];
export const totalmem = (): number => 8 * 1024 ** 3;
export const freemem = (): number => 4 * 1024 ** 3;
export const release = (): string => "6.0.0";
export const type = (): string => "Linux";
export const arch = (): string => "x64";
export default { homedir, tmpdir, platform, hostname, userInfo, EOL, cpus, totalmem, freemem, release, type, arch };
