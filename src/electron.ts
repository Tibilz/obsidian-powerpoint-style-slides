/*
 * Zugriff auf Electron – nur für den PDF-Export (printToPDF + Speichern-Dialog).
 * Ist er nicht verfügbar, fällt der Export auf den System-Druckdialog zurück.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function electronRemote(): any | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const electron = (window as any).require?.("electron");
		if (electron?.remote) return electron.remote;
	} catch { /* ignore */ }
	try {
		return (window as any).require?.("@electron/remote") ?? null;
	} catch {
		return null;
	}
}
