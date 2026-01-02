/**
 * ============================================================================
 * ARCHIVO: dashboard.server.gs
 * Descripción: Lógica del servidor para el Dashboard Principal
 * ============================================================================
 */

/**
 * Obtiene las estadísticas y datos para el dashboard principal.
 * @return {Object} Objeto con contadores y listas de actividad reciente.
 */
function getDashboardStats() {
    try {
        console.log('[getDashboardStats] Iniciando carga de métricas...');

        // 1. Cargar todos los comunicados (usamos la función existente en comunicados.crud.gs)
        const comunicadosResult = readAllComunicados();
        if (!comunicadosResult.success) {
            throw new Error(comunicadosResult.message);
        }

        const allComunicados = comunicadosResult.data || [];

        // 2. Calcular Métricas
        const total = allComunicados.length;

        // Estado 1 suele ser "Pendiente" o "Activo" (asumiendo convención, ajustar según reglas reales)
        // Revisando comunicados.crud.gs, status se guarda como entero o string.
        // Vamos a contar por status para ser agnósticos del ID
        const pendientes = allComunicados.filter(c => c.status == 1).length;
        const completados = allComunicados.filter(c => c.status == 2).length; // Asumiendo 2 como cerrado/completado

        // 3. Actividad Reciente (Últimos 5 creados/modificados basándonos en fecha)
        // readAllComunicados ya retorna ordenado por fecha descendente
        const recientes = allComunicados.slice(0, 5).map(c => ({
            id: c.id,
            titulo: c.comunicado,
            descripcion: c.descripcion, // Added description
            presupuesto: c.presupuesto, // Added budget
            // cuenta: c.cuenta, // Removed based on user feedback
            status: c.status,
            fecha: c.fecha
        }));

        console.log(`[getDashboardStats] Éxito. Total: ${total}, Recientes: ${recientes.length}`);

        return {
            success: true,
            stats: {
                totalComunicados: total,
                pendientes: pendientes,
                completados: completados
            },
            recentActivity: recientes
        };

    } catch (e) {
        console.error('[getDashboardStats] Error:', e);
        return {
            success: false,
            message: e.message,
            stats: { totalComunicados: 0, pendientes: 0, completados: 0 },
            recentActivity: []
        };
    }
}
