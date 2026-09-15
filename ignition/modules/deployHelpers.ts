const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Read the first NON-EMPTY env var in priority order (module-specific
// override first, then the shared name). An empty value (X=) counts as
// unset and falls through, so a blank line in .env can never mask the
// shared value or the default.
export function envString(...names: string[]): string {
    for (const name of names) {
        const value = process.env[name];
        if (value) return value;
    }
    return "";
}

export function envNumber(defaultValue: number, ...names: string[]): number {
    const value = envString(...names);
    return value ? Number(value) : defaultValue;
}

export function envBigInt(defaultValue: bigint, ...names: string[]): bigint {
    const value = envString(...names);
    return value ? BigInt(value) : defaultValue;
}

// Fail fast with a clear, named message instead of a cryptic ethers ABI-encode
// error deep in execution when a required constructor address is blank/missing.
export function makeRequireAddress(moduleName: string) {
    return function requireAddress(label: string, value: string): void {
        if (!ADDRESS_RE.test(value)) {
            throw new Error(
                `${moduleName}: ${label} must be a valid address but got "${value}". ` +
                    "Set the corresponding env var in your .env before deploying.",
            );
        }
    };
}
