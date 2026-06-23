const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

// Configuración de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configuración de Google Sheets
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const ID_PLANILLA = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const doc = new GoogleSpreadsheet(ID_PLANILLA, serviceAccountAuth);

async function sincronizarTractoresContinuo() {
    try {
        // 1. Conectar a Sheets y descargar la celda H1
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['choferes y unidades'];
        if (!sheet) return console.error("❌ Pestaña 'choferes y unidades' no encontrada.");

        await sheet.loadCells('H1');
        const jsonString = sheet.getCellByA1('H1').value;
        if (!jsonString) return;

        const flotaJSON = JSON.parse(jsonString);

        // 2. Descargar diccionario de Tractores (Supabase: Tabla units)
        const { data: unidades, error: errU } = await supabase.from('units').select('id, tractor');
        if (errU) throw errU;

        const mapaTractores = {};
        unidades.forEach(u => {
            if (u.tractor) mapaTractores[String(u.tractor).trim().toUpperCase()] = u.id;
        });

        // 3. Descargar estado actual de Choferes (Supabase) para evitar updates redundantes
        const { data: choferesDB, error: errC } = await supabase.from('choferes').select('id, nombre, unidad_id');
        if (errC) throw errC;

        const mapaChoferesDB = {};
        choferesDB.forEach(c => {
            // Normalizamos el nombre para cruzarlo sin problemas de tildes o mayúsculas
            const nombreNorm = String(c.nombre).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
            mapaChoferesDB[nombreNorm] = c;
        });

        // 4. Comparación y Actualización
        let actualizaciones = 0;

        for (const item of flotaJSON) {
            const nombreRaw = String(item.nombre || '').trim();
            const tractorJSON = String(item.tractor || '').trim().toUpperCase();

            if (!nombreRaw) continue;
            const nombreNorm = nombreRaw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

            const choferActualDB = mapaChoferesDB[nombreNorm];
            
            // Si el chofer existe en la DB
            if (choferActualDB) {
                // Buscamos cuál debería ser su nuevo ID de unidad según el Excel
                const nuevoUnidadId = mapaTractores[tractorJSON] || null;

                // 🌟 LÓGICA EFICIENTE: Solo actualizamos si el ID de la unidad cambió
                if (choferActualDB.unidad_id !== nuevoUnidadId) {
                    const { error: errUpdate } = await supabase
                        .from('choferes')
                        .update({ unidad_id: nuevoUnidadId })
                        .eq('id', choferActualDB.id);

                    if (!errUpdate) {
                        actualizaciones++;
                        console.log(`🚚 Cambio detectado: ${nombreRaw} ahora maneja ${tractorJSON || 'Ninguno'}`);
                    }
                }
            }
        }

        if (actualizaciones > 0) {
            console.log(`✅ Sincronización de Flota terminada: ${actualizaciones} choferes reasignados en Supabase.`);
        }

    } catch (error) {
        console.error("❌ Error en Sincronizador de Flota:", error.message);
    }
}

module.exports = { sincronizarTractoresContinuo };