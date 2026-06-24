const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const ID_PLANILLA = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const doc = new GoogleSpreadsheet(ID_PLANILLA, serviceAccountAuth);

async function sincronizarTractoresContinuo() {
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle['choferes y unidades'];
        if (!sheet) return false; // Retornamos false si falla

        await sheet.loadCells('H1');
        const jsonString = sheet.getCellByA1('H1').value;
        if (!jsonString) return false;

        const flotaJSON = JSON.parse(jsonString);

        // Limpiamos la caché para que Node no acumule memoria basura
        try { sheet.resetLocalCache(); } catch(e) {}

        const { data: unidades, error: errU } = await supabase.from('units').select('id, tractor');
        if (errU) throw errU;

        const mapaTractores = {};
        unidades.forEach(u => {
            if (u.tractor) mapaTractores[String(u.tractor).trim().toUpperCase()] = u.id;
        });

        const { data: choferesDB, error: errC } = await supabase.from('choferes').select('id, nombre, unidad_id');
        if (errC) throw errC;

        const mapaChoferesDB = {};
        choferesDB.forEach(c => {
            const nombreNorm = String(c.nombre).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
            mapaChoferesDB[nombreNorm] = c;
        });

        let actualizaciones = 0;
        let huboCambiosReales = false; // 🌟 Bandera para avisar al servidor

        for (const item of flotaJSON) {
            const nombreRaw = String(item.nombre || '').trim();
            const tractorJSON = String(item.tractor || '').trim().toUpperCase();

            if (!nombreRaw) continue;
            const nombreNorm = nombreRaw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

            const choferActualDB = mapaChoferesDB[nombreNorm];
            
            if (choferActualDB) {
                const nuevoUnidadId = mapaTractores[tractorJSON] || null;

                if (choferActualDB.unidad_id !== nuevoUnidadId) {
                    const { error: errUpdate } = await supabase
                        .from('choferes')
                        .update({ unidad_id: nuevoUnidadId })
                        .eq('id', choferActualDB.id);

                    if (!errUpdate) {
                        actualizaciones++;
                        huboCambiosReales = true; // 🌟 Registramos que la flota cambió
                        console.log(`🚚 Cambio detectado: ${nombreRaw} ahora maneja ${tractorJSON || 'Ninguno'}`);
                    }
                }
            }
        }

        if (actualizaciones > 0) {
            console.log(`✅ Sincronización de Flota: ${actualizaciones} choferes reasignados en Supabase.`);
        }

        return huboCambiosReales; // 🌟 Devolvemos true o false

    } catch (error) {
        console.error("❌ Error en Sincronizador de Flota:", error.message);
        return false;
    }
}

module.exports = { sincronizarTractoresContinuo };
