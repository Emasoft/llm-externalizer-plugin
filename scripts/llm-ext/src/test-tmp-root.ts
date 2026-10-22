import { realpathSync } from "node:fs";
/**
 * Temp root for tests that create a config folder. config.ts getConfigDir()
 * accepts only $HOME or realpath("/tmp"), but os.tmpdir() follows TMPDIR, which
 * on a default macOS terminal is /var/folders/... and is rejected ("Config
 * directory ... is outside allowed paths", TRDD-YUML4ISF). The guard must not be
 * widened to os.tmpdir() (the caller controls TMPDIR), so tests root their config
 * folders here instead. Same reason test-hermetic-config.ts uses "/tmp".
 * /tmp does not exist on Windows (no Windows CI leg today).
 */
export const tmpdir = (): string => realpathSync("/tmp");
