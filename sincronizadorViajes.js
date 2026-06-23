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
        return json.values || [];
    } catch (error) {
        return [];
    }
}

let trabajando = false;

// 👉 AHORA RECIBE UN PARÁMETRO: Por defecto 2 días para que sea una lectura "microscópica"
async function sincronizarViajesASupabase(diasHaciaAtras = 2) {
    if (trabajando) return;
    trabajando = true;

    try {
        console.log(`⏳ [Micro-Sync] Leyendo solo los últimos ${diasHaciaAtras} días desde Google Sheets...`);
        
        const fechaLimiteObj = new Date();
        fechaLimiteObj.setDate(fechaLimiteObj.getDate() - diasHaciaAtras);
        const limiteIso = fechaLimiteObj.toISOString().split('T')[0];

        const { data: choferesDB } = await supabase.from('choferes').select('id, nombre');
        const mapaChoferes = {};
        if (choferesDB) choferesDB.forEach(c => { mapaChoferes[normalizar(c.nombre)] = c.id; });

        let viajesDetalleObj = {};
        const fila12Data = await leerRangoLiviano('API_CACHE_BASICO!A12:ZZ12');
        if (fila12Data.length > 0) {
            const jsonHR = fila12Data[0].map(val => String(val).replace(/^'/, "")).join("");
            if (jsonHR) viajesDetalleObj = JSON.parse(jsonHR);
        }

        let mapaKms = {};
        const kmData = await leerRangoLiviano('api_km!A:A');
        if (kmData.length > 0) {
            const kmStr = kmData.map(row => String(row[0] || '').replace(/^'/, "")).join("");
            if (kmStr) mapaKms = JSON.parse(kmStr);
        }

        const dbRows = {};

        for (let choferNorm in viajesDetalleObj) {
            const choferId = mapaChoferes[normalizar(choferNorm)];
            if (!choferId) continue;
            if (!dbRows[choferId]) dbRows[choferId] = {};

            for (let fechaIso in viajesDetalleObj[choferNorm]) {
                if (fechaIso < limiteIso) continue; // 🛑 IGNORA LO VIEJO

                const src = viajesDetalleObj[choferNorm][fechaIso];
                let arrHR = [];
                if (src.hoja_ruta) {
                    arrHR = (Array.isArray(src.hoja_ruta) ? src.hoja_ruta : [src.hoja_ruta]).map(h => String(h || '').trim()).filter(Boolean);
                }

                dbRows[choferId][fechaIso] = {
                    chofer_id: choferId, fecha: fechaIso, 
                    dominio: src.dominio ? String(src.dominio).trim().substring(0, 20) : null,
                    km: 0, liviano: parseFloat(src.liviano) || 0, euro: parseFloat(src.euro) || 0,
                    campo: parseFloat(src.campo) || 0, infinia_d: parseFloat(src.infiniaD) || 0, hoja_ruta: arrHR
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
                    if (fechaIso < limiteIso) return; // 🛑 IGNORA LO VIEJO
                    
                    if (!dbRows[choferId][fechaIso]) {
                        dbRows[choferId][fechaIso] = {
                            chofer_id: choferId, fecha: fechaIso, dominio: null, km: 0,
                            liviano: 0, euro: 0, campo: 0, infinia_d: 0, hoja_ruta: []
                        };
                    }
                    dbRows[choferId][fechaIso].km = parseFloat(reg.km) || 0;
                }
            });
        }

        const rowsParaInsertar = [];
        for (let chId in dbRows) {
            for (let fIso in dbRows[chId]) rowsParaInsertar.push(dbRows[chId][fIso]);
        }

        if (rowsParaInsertar.length > 0) {
            console.log(`🚀 Guardando ${rowsParaInsertar.length} ediciones recientes en Supabase...`);
            for (let i = 0; i < rowsParaInsertar.length; i += 150) {
                const chunk = rowsParaInsertar.slice(i, i + 150);
                await supabase.from('registros_viajes_km').upsert(chunk, { onConflict: 'chofer_id,fecha' });
            }
            console.log(`✅ Micro-Sync completado.`);
        }

    } catch (error) { console.error("❌ Error en Micro-Sync:", error.message); } 
    finally { trabajando = false; }
}

module.exports = { sincronizarViajesASupabase };
