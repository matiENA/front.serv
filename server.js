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
// 1. CONFIGURACIÓN DE CONEXIONES
// ==========================================
const GAS_URL = "https://script.google.com/macros/s/AKfycbzqk-ag2kmaEsGrScmN4s8SPjpwwEybyuF7Fy_vad8fiGuF_rbDsU5Iw_bZO3WvKrY/exec";

// Configuración Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'https://tu-proyecto.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'tu-anon-key';
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuración Google Sheets
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const ID_PLANILLA = process.env.SPREADSHEET_ID || 'T1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc'; 
const doc = new GoogleSpreadsheet(ID_PLANILLA, serviceAccountAuth);

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

// 👉 Helper global: Lo sacamos afuera para que el Webhook también lo pueda usar
const fetchSeguro = async (url, nombre) => {
    try {
        const r = await fetch(url);
        const text = await r.text();
        if (text.trim().startsWith('<')) {
            console.error(`❌ Alerta en [${nombre}]: GAS devolvió HTML.`);
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
        
        // 1. Descargamos Todo desde GAS (Aquí viene el calendario de días)
        const [resDiagGAS, resNombresMes, resViajesDirecto, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`, 'Diagramas Legacy'),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`, 'Mes Actual'),
            fetchSeguro(`${GAS_URL}?action=obtenerViajesYHRDirecto`, 'Lectura HR'),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs Legacy')
        ]);

        // 2. Consultamos Supabase (NUESTRA FUENTE DE VERDAD PARA FLOTA Y PERSONAL)
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
// 🔔 3. RECEPTOR DE WEBHOOKS (Remplaza al Polling)
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    // 1. Liberamos a Google de inmediato para que el usuario en el Excel no sienta "lag"
    res.json({ success: true, message: "Recibido" }); 

    const evento = req.body.evento || 'TODO';
    console.log(`🔔 Webhook disparado por cambio en: ${evento}`);

    try {
        // 2. ACTUALIZACIÓN GRANULAR (Solo recargamos lo que cambió)
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
            // Si el evento es 'DIAGRAMA' o cualquier otro, requiere el Merge completo con Supabase
            await actualizarCacheDesdeGoogle();
        }

    } catch (error) {
        console.error("❌ Error procesando el webhook:", error);
    }
});

// ==========================================
// 4. RUTAS DE LA API
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

// 👉 EL INTERCEPTOR: Documentos van a Supabase, el Resto a GAS
app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;

        // 🌟 MÓDULO MIGRADO 1: DOCUMENTOS
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

            // Enviamos a GAS como respaldo legacy
            fetch(GAS_URL, {
                method: 'POST',
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(body)
            }).catch(e => console.error("Error Sheets:", e));

            // Actualización instantánea para el cliente que guardó
            return res.json({ success: true, message: "Documentos sincronizados." });
        }

        // =========================================================
        // FLUJO LEGACY NORMAL (Diagramas, Hojas de Ruta, etc.)
        // =========================================================
        const respuestaGoogle = await fetch(GAS_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(body)
        }).then(r => r.json());

        if (body && body.action !== 'login') {
            actualizarCacheDesdeGoogle(); // Refresca todo tras la edición desde la web
        }
        res.json(respuestaGoogle);

    } catch (error) {
        console.error("Fallo general en Proxy:", error);
        res.status(500).json({ success: false, error: "Fallo en la DB" });
    }
});

app.get('/api/maestro-choferes', (req, res) => {
    if (!cacheDatosGlobales.diagramas || !cacheDatosGlobales.diagramas.diagramas) {
        return res.status(503).send("Cargando DB...");
    }
    const html = `<!DOCTYPE html><html><body><pre>${JSON.stringify(cacheDatosGlobales.diagramas.diagramas, null, 2)}</pre></body></html>`;
    res.send(html);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor Híbrido corriendo en puerto ${PORT}`));
