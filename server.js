const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

// Librerías para conexión
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. CONFIGURACIÓN DE CONEXIONES (Vía Variables de Entorno)
// ==========================================
// 🔗 Google Apps Script
const GAS_URL = process.env.GAS_URL;

// 🐘 Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 📊 Google Sheets Directo
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const ID_PLANILLA = process.env.SPREADSHEET_ID; 
const doc = new GoogleSpreadsheet(ID_PLANILLA, serviceAccountAuth);

// 💾 Memoria RAM del Servidor
let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

// 👉 Helper Global Seguro
const fetchSeguro = async (url, nombre) => {
    try {
        const r = await fetch(url);
        const text = await r.text();
        if (text.trim().startsWith('<')) {
            console.error(`❌ Alerta en [${nombre}]: GAS devolvió HTML (Posible timeout o error en Google).`);
            return null;
        }
        return JSON.parse(text);
    } catch (err) {
        console.error(`❌ Error parseando JSON en [${nombre}]:`, err.message);
        return null;
    }
};

// ==========================================
// 2. EL WORKER DE NODE (MERGE HÍBRIDO)
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("🔄 Sincronizando COMPLETO: Supabase (Flota) + GAS (Diagramas)...");
        
        // 1. Descargamos Todo desde GAS (Legacy)
        const [resDiagGAS, resNombresMes, resViajesDirecto, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`, 'Diagramas Legacy'),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`, 'Mes Actual'),
            fetchSeguro(`${GAS_URL}?action=obtenerViajesYHRDirecto`, 'Lectura HR'),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs Legacy')
        ]);

        // 2. Consultamos Supabase (NUESTRA FUENTE DE VERDAD)
        const { data: choferes, error: errSupabase } = await supabase
            .from('choferes')
            .select('nombre, c_servicio, units(n_ute, tractor, semi)');

        if (errSupabase) console.error("⚠️ Error leyendo Supabase:", errSupabase.message);

        // 3. EL GRAN MERGE
        let diagramasHibridos = [];
        
        if (choferes) {
            const dictDiasGAS = {};
            if (resDiagGAS && resDiagGAS.diagramas) {
                resDiagGAS.diagramas.forEach(d => {
                    dictDiasGAS[d.nom.trim().toLowerCase()] = d.dias;
                });
            }

            diagramasHibridos = choferes.map(chofer => {
                const nomNorm = chofer.nombre.trim().toLowerCase();
                const calendario = dictDiasGAS[nomNorm] || {}; 

                return {
                    _safeId: "drv_" + nomNorm.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_"),
                    nom: chofer.nombre,
                    tractor: chofer.units ? (chofer.units.tractor || '') : '',
                    semi: chofer.units ? (chofer.units.semi || '') : '',
                    srv: chofer.c_servicio || '',
                    n_ute: chofer.units ? (chofer.units.n_ute || '') : '',
                    td: '-', 
                    hex1: "", hex2: "", hex_1: "#ffffff", hex_2: "#ffffff",
                    dias: calendario 
                };
            });
        }

        // 4. Empaquetar y enviar a la memoria RAM
        let resDiag = { diagramas: diagramasHibridos };
        
        if (resDiagGAS && resDiagGAS.documentos) resDiag.documentos = resDiagGAS.documentos;
        if (resDiagGAS && resDiagGAS.habilitaciones) resDiag.habilitaciones = resDiagGAS.habilitaciones;
        if (resDiagGAS && resDiagGAS.certificados) resDiag.certificados = resDiagGAS.certificados;
        
        if (resViajesDirecto) resDiag.nuevaSeccionViajes = resViajesDirecto; 
        else resDiag.nuevaSeccionViajes = {}; 

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs || { campo: {}, infinia: {}, liviano: {}, euro: {}, estados: {}, codigosExtra: {} };
        cacheDatosGlobales.nombresMesActual = resNombresMes || [];
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        console.log("✅ Caché global Híbrido actualizado con éxito.");
        io.emit('datos_actualizados', cacheDatosGlobales);

    } catch (error) {
        console.error("Error crítico general:", error);
    }
}

// Arranca el ciclo del backend por primera vez al encender el servidor
actualizarCacheDesdeGoogle();

// ==========================================
// 🔔 3. RECEPTOR DE WEBHOOKS (Actualización por Eventos)
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    // 1. Liberamos a Google de inmediato para evitar lag en el Excel
    res.json({ success: true, message: "Recibido" }); 

    const evento = req.body.evento || 'TODO';
    console.log(`🔔 Webhook disparado por cambio en: ${evento}`);

    try {
        // 2. ACTUALIZACIÓN GRANULAR (Ahorra memoria y procesador)
        if (evento === 'KM') {
            const nuevosHR = await fetchSeguro(`${GAS_URL}?action=obtenerViajesYHRDirecto`, 'Hojas de Ruta');
            if (cacheDatosGlobales.diagramas) {
                cacheDatosGlobales.diagramas.nuevaSeccionViajes = nuevosHR || {};
            }
            cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
            io.emit('datos_actualizados', cacheDatosGlobales);
            console.log(`✅ Socket emitido tras webhook de KM`);
        } 
        else if (evento === 'TD') {
            const nuevosTDs = await fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs');
            cacheDatosGlobales.tds = nuevosTDs || cacheDatosGlobales.tds;
            cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
            io.emit('datos_actualizados', cacheDatosGlobales);
            console.log(`✅ Socket emitido tras webhook de TD`);
        } 
        else {
            // Eventos mayores (DIAGRAMA) disparan el Merge Completo
            await actualizarCacheDesdeGoogle();
        }

    } catch (error) {
        console.error("❌ Error procesando el webhook:", error);
    }
});

// ==========================================
// 4. RUTAS DE LA API (Endpoints del Front-End)
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

// 👉 EL INTERCEPTOR
app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;

        // 🌟 MÓDULO MIGRADO: DOCUMENTOS
        if (body && body.action === 'guardarDocumentos') {
            console.log(`Interceptando guardado de documentos para: ${body.nombre}`);
            const { nombre, exVen, licVen, certVen } = body;
            
            const { data: choferData, error: errChofer } = await supabase
                .from('choferes')
                .select('id')
                .ilike('nombre', nombre)
                .single();

            if (!errChofer && choferData) {
                const choferId = choferData.id;
                await supabase
                    .from('documentos_choferes')
                    .upsert({ 
                        chofer_id: choferId, 
                        venc_periodico: exVen || null, 
                        venc_licencia: licVen || null, 
                        venc_cert_mp: certVen || null,
                        actualizado_en: new Date()
                    }, { onConflict: 'chofer_id' });
            }

            // Enviamos a GAS de fondo como Legacy
            fetch(GAS_URL, {
                method: 'POST',
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(body)
            }).catch(e => console.error("Error Sheets:", e));

            return res.json({ success: true, message: "Documentos sincronizados." });
        }

        // =========================================================
        // FLUJO LEGACY NORMAL (Hojas de Ruta, Estados, Login)
        // =========================================================
        const respuestaGoogle = await fetch(GAS_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(body)
        }).then(r => r.json());

        // Si se modificó algo, recargamos (Refresco post-interacción)
        if (body && body.action !== 'login') {
            actualizarCacheDesdeGoogle(); 
        }
        res.json(respuestaGoogle);

    } catch (error) {
        console.error("Fallo general en Proxy:", error);
        res.status(500).json({ success: false, error: "Fallo en la DB" });
    }
});

// Maestro Legacy (Por si se usa como debug)
app.get('/api/maestro-choferes', (req, res) => {
    if (!cacheDatosGlobales.diagramas || !cacheDatosGlobales.diagramas.diagramas) {
        return res.status(503).send("Cargando DB...");
    }
    const html = `<!DOCTYPE html><html><body><pre>${JSON.stringify(cacheDatosGlobales.diagramas.diagramas, null, 2)}</pre></body></html>`;
    res.send(html);
});

// SPA Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor Híbrido corriendo en puerto ${PORT}`));

// ==========================================
// 🐘 4. RECEPTOR DE WEBHOOKS (Desde Supabase)
// ==========================================
app.post('/api/webhook/supabase', async (req, res) => {
    // 1. Validar seguridad (Opcional pero recomendado)
    // Para asegurarnos de que el mensaje viene realmente de tu Supabase
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.SUPABASE_WEBHOOK_SECRET || 'MiClaveSecreta123'}`) {
        return res.status(403).json({ error: "No autorizado" });
    }

    // 2. Liberamos a Supabase de inmediato
    res.json({ success: true, message: "Recibido por Node" }); 

    const payload = req.body;
    /* Payload típico de Supabase:
       { type: 'UPDATE', table: 'choferes', record: {...}, old_record: {...} }
    */
    console.log(`🐘 Webhook Supabase: Cambio en tabla [${payload.table}] | Acción: ${payload.type}`);

    try {
        // 3. Dependiendo de qué tabla cambió, decidimos qué actualizar
        const tablasMonitoreadas = ['choferes', 'units', 'documentos_choferes', 'movimientos', 'estados_diarios'];
        
        if (tablasMonitoreadas.includes(payload.table)) {
            // Si cambia la estructura de la flota o sus documentos, 
            // disparamos el Gran Merge Híbrido para refrescar todo.
            console.log("🔄 Recargando datos desde Supabase...");
            await actualizarCacheDesdeGoogle();
        }

    } catch (error) {
        console.error("❌ Error procesando webhook de Supabase:", error);
    }
});
