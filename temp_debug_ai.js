
/**
 * DEBUG: Listar modelos disponibles para esta API Key.
 * Ejecutar manualmente desde el editor.
 */
function debugListModels() {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) {
        console.error('No API Key');
        return;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    try {
        const response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
        console.log('Code:', response.getResponseCode());
        console.log('Response:', response.getContentText());
    } catch (e) {
        console.error('Error fetching models:', e);
    }
}
