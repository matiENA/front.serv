const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const ID_PLANILLA = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

async function leerRangoLiviano(rango) {
    try {
        const tokenResponse = await serviceAccountAuth.getAccessToken();
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${ID_PLANILLA}/values/${rango}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tokenResponse.token}` } });
        const json = await res.json();
        if (json.error) throw new Error(json.error.message);
        return json.values || [];
    } catch (error) {
        console.error(`Error de red al leer ${rango}:`, error.message);
        return [];
    }
}

// 🛡️ CANDADO ANTI-COLAPSO
let trabajando = false;

async function sincronizarViajesASupabase() {
    if (trabajando) {
        console.log("⚠️ [Worker Viajes] Ejecución múltiple detectada. Se omitirá para proteger la RAM.");
        return;
    }
    trabajando = true;

    try {
        console.log("⏳ [Worker Viajes] Descargando histórico (Modo Low-Memory)...");
        
        const { data: choferesDB, error: errC } = await supabase.from('choferes').select('id, nombre');
        if (errC) throw errC;
        
        const mapaChoferes = {};
        choferesDB.forEach(c => { mapaChoferes[normalizar(c.nombre)] = c.id; });

        let viajesDetalleObj = {};
        const fila12Data = await leerRangoLiviano('API_CACHE_BASICO!A12:ZZ12');
        if (fila12Data.length > 0) {
            const chunksFila12 = fila12Data[0].map(val => String(val).replace(/^'/, ""));
            const jsonHR = chunksFila12.join("");
            if (jsonHR) viajesDetalleObj = JSON.parse(jsonHR);
        }

        let mapaKms = {};
        const kmData = await leerRangoLiviano('api_km!A:A');
        if (kmData.length > 0) {
            const chunksKm = kmData.map(row => String(row[0] || '').replace(/^'/, ""));
            const kmStr = chunksKm.join("");
            if (kmStr) mapaKms = JSON.parse(kmStr);
        }

        const dbRows = {};

        for (let choferNorm in viajesDetalleObj) {
            const choferId = mapaChoferes[normalizar(choferNorm)];
            if (!choferId) continue;
            if (!dbRows[choferId]) dbRows[choferId] = {};

            for (let fechaIso in viajesDetalleObj[choferNorm]) {
                const src = viajesDetalleObj[choferNorm][fechaIso];
                dbRows[choferId][fechaIso] = {
                    chofer_id: choferId, fecha: fechaIso, dominio: src.dominio || null,
                    km: 0, liviano: src.liviano || 0, euro: src.euro || 0,
                    campo: src.campo || 0, infinia_d: src.infiniaD || 0, hoja_ruta: src.hoja_ruta || []
                };
            }
        }

        for (let choferRaw in mapaKms) {
            const choferId = mapaChoferes[normalizar(choferRaw)];
            if (!choferId) continue;
            if (!dbRows[choferId]) dbRows[choferId] = {};

            mapaKms[choferRaw].forEach(reg => {
                let partes = reg.fechaCorta.split('/');
                if (partes.length === 3) {
                    let fechaIso = `20${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
                    if (!dbRows[choferId][fechaIso]) {
                        dbRows[choferId][fechaIso] = {
                            chofer_id: choferId, fecha: fechaIso, dominio: null, km: 0,
                            liviano: 0, euro: 0, campo: 0, infinia_d: 0, hoja_ruta: []
                        };
                    }
                    dbRows[choferId][fechaIso].km = reg.km || 0;
                }
            });
        }

        const rowsParaInsertar = [];
        for (let chId in dbRows) {
            for (let fIso in dbRows[chId]) {
                rowsParaInsertar.push(dbRows[chId][fIso]);
            }
        }

        // 👉 LIBERACIÓN MANUAL DE MEMORIA
        viajesDetalleObj = null;
        mapaKms = null;

        if (rowsParaInsertar.length === 0) return;

        console.log(`🚀 Volcando ${rowsParaInsertar.length} registros a Supabase...`);
        
        let insertadosOk = 0;
        for (let i = 0; i < rowsParaInsertar.length; i += 150) {
            const chunk = rowsParaInsertar.slice(i, i + 150);
            const { error: errUpsert } = await supabase.from('registros_viajes_km').upsert(chunk, { onConflict: 'chofer_id,fecha' });
            if (!errUpsert) insertadosOk += chunk.length;
            else console.error("Error Upsert parcial:", errUpsert.message);
        }

        console.log(`✅ Migración Completa: ${insertadosOk} registros históricos sincronizados.`);

    } catch (error) {
        console.error("❌ Error CRÍTICO en sincronizador de Viajes:", error.message);
    } finally {
        trabajando = false; // LIBERAMOS EL CANDADO SIEMPRE
    }
}

module.exports = { sincronizarViajesASupabase };
