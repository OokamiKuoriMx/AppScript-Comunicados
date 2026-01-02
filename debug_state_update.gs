function diagnoseStateUpdate() {
    console.log('=== DIAGNOSIS STATE UPDATE START ===');

    // 1. Mock Cache with a "Colima" record
    const mockCache = {
        estados: [
            { id: 1, estado: 'Colima' },
            { id: 2, estado: 'Jalisco' }
        ],
        datosGenerales: [
            { id: 100, idComunicado: 50, descripcion: 'Test', idEstado: 1 } // Currently Colima
        ],
        comunicados: [
            { id: 50, idReferencia: 99, comunicado: 'C-001' }
        ],
        cuentas: [
            { id: 99, referencia: 'REF-01' }
        ],
        distritosRiego: [], newsletter: [], siniestros: []
    };

    // 2. Simulate CSV Input "Jalisco"
    const csvInput = {
        header: {
            refCta: 'REF-01',
            comunicadoId: 'C-001',
            estado: 'Jalisco', // CHANGE REQUESTED
            tipoRegistro: 'ORIGEN'
        }
    };

    // 3. Test _resolveIdFromCache
    console.log('Testing ID Resolution...');
    const idColima = _resolveIdTest(mockCache.estados, 'Colima', 'estado');
    const idJalisco = _resolveIdTest(mockCache.estados, 'Jalisco', 'estado');
    console.log(`Resolved Colima ID: ${idColima}`);
    console.log(`Resolved Jalisco ID: ${idJalisco}`);

    // 4. Test Comparison Logic (Replicating importacion.server.gs logic)
    const dgActual = mockCache.datosGenerales[0];
    const idEstadoNuevo = _resolveIdTest(mockCache.estados, csvInput.header.estado, 'estado');

    console.log(`Current DB State ID: ${dgActual.idEstado}`);
    console.log(`New CSV State ID: ${idEstadoNuevo}`);

    let hasChanges = false;
    if (idEstadoNuevo && String(idEstadoNuevo) !== String(dgActual.idEstado)) {
        console.log('CHANGE DETECTED: State ID differs.');
        hasChanges = true;
    } else {
        console.log('NO CHANGE DETECTED.');
    }

    console.log('=== DIAGNOSIS END ===');
}

// Copy of helper for local test
function _resolveIdTest(list, value, fieldName) {
    if (!value) return null;
    const clean = String(value).toUpperCase().trim();
    const found = list.find(item => {
        return String(item[fieldName] || '').toUpperCase().trim() === clean;
    });
    return found ? found.id : null;
}
