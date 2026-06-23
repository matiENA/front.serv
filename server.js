const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const { sincronizarTractoresContinuo } = require('./sincronizadorFlota'); 
const { sincronizarViajesASupabase } = require('./sincronizadorViajes'); 

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. CONFIGURACIÓN 
// ==========================================
const GAS_URL = process.env.GAS_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const ID_PLANILLA = process.env.SPREADSHEET_ID; 

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

const fetchSeguro = async (url, nombre) => {
    try {
        const r = await fetch(url);
        const text = await r.text();
        if (text.trim().startsWith('<')) {
            console.error(`❌ Alerta en [${nombre}]: GAS devolvió HTML (Sobrecarga detectada).`);
            return null;
        }
        return JSON.parse(text);
    } catch (err) {
        console.error(`❌ Error de red en [${nombre}]:`, err.message);
        return null;
    }
};

// ==========================================
// 🛡️ SISTEMA DE COLAS (CANDADOS DE HILO ÚNICO)
// ==========================================

let ejecutandoKM = false;
let pendienteKM = false;

async function flujoEncoladoKM() {
    if (ejecutandoKM) {
        pendienteKM = true; 
        return; 
    }
    ejecutandoKM = true;
    try {
        console.log("🚚 Procesando KM hacia SQL y RAM...");
        await sincronizarViajesASupabase();
        await actualizarCacheDesdeGoogle(); 
        console.log(`✅ Socket emitido tras webhook de KM`);
    } finally {
        ejecutandoKM = false;
        if (pendienteKM) {
            pendienteKM = false;
            flujoEncoladoKM(); // Se ejecuta el que estaba esperando
        }
    }
}

let ejecutandoGlobal = false;
let pendienteGlobal = false;

async function flujoEncoladoGlobal() {
    if (ejecutandoGlobal) {
        pendienteGlobal = true;
        return;
    }
    ejecutandoGlobal = true;
    try {
        await actualizarCacheDesdeGoogle();
    } finally {
        ejecutandoGlobal = false;
        if (pendienteGlobal) {
            pendienteGlobal = false;
            flujoEncoladoGlobal();
        }
    }
}

// ==========================================
// 🚀 WORKERS PERMANENTES 
// ==========================================
const TIEMPO_SYNC = 5 * 60 * 1000; 

setTimeout(() => {
    sincronizarTractoresContinuo();
    flujoEncoladoKM(); // La primera carga lanza todo ordenado
}, 5000); 

setInterval(() => {
    sincronizarTractoresContinuo();
    flujoEncoladoKM(); 
}, TIEMPO_SYNC);


// ==========================================
// 2. EL WORKER DE NODE (MERGE HÍBRIDO + SQL)
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("🔄 Sincronizando Memoria RAM (Supabase + Google)...");
        
        const [resDiagGAS, resNombresMes, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`, 'Diagramas Legacy'),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`, 'Mes Actual'),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs Legacy')
        ]);

       // =========================================================================
        // 2. Consultamos Supabase (Padrón de Choferes) 
        // IMPORTANTE: Agregamos explícitamente el campo 'id'
        // =========================================================================
        const { data: choferes, error: errSupabase } = await supabase
            .from('choferes')
            .select('id, nombre, c_servicio, units(n_ute, tractor, semi)');

        if (errSupabase) console.error("⚠️ Error leyendo Supabase:", errSupabase.message);

        // 👉 DICCIONARIO ANTI-FALLOS: Vinculamos ID con Nombre Normalizado
        const mapaNombresId = {};
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        if (choferes) {
            choferes.forEach(c => {
                mapaNombresId[c.id] = normalizar(c.nombre);
            });
        }

        // =========================================================================
        // 🌟 3. LEER LOS VIAJES DIRECTAMENTE DESDE SUPABASE SQL
        // =========================================================================
        const fechaLimite = new Date();
        fechaLimite.setDate(fechaLimite.getDate() - 365); // Traemos 1 AÑO de historia, no solo 60 días
        const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];

        // Ya no hacemos el Join '.select('*, choferes(nombre)')' que suele fallar en Supabase.
        // Ahora traemos la tabla pura de viajes.
        const { data: registrosViajesSQL, error: errV } = await supabase
            .from('registros_viajes_km')
            .select('*')
            .gte('fecha', fechaLimiteStr);

        let nuevaSeccionViajes = {};

        if (!errV && registrosViajesSQL) {
            registrosViajesSQL.forEach(row => {
                // Obtenemos el nombre exacto del chofer usando su ID desde nuestro diccionario
                const choferNorm = mapaNombresId[row.chofer_id];
                if (!choferNorm) return; 
                
                if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                
                // Formateamos seguro la fecha para que coincida con el Frontend
                const fechaLimpia = String(row.fecha).split('T')[0];

                nuevaSeccionViajes[choferNorm][fechaLimpia] = {
                    dominio: row.dominio || '',
                    km: Number(row.km || 0),
                    liviano: Number(row.liviano || 0),
                    euro: Number(row.euro || 0),
                    campo: Number(row.campo || 0),
                    infiniaD: Number(row.infinia_d || 0),
                    hoja_ruta: row.hoja_ruta || []
                };
            });
        }
        let diagramasHibridos = [];
        if (choferes) {
            const dictDiasGAS = {};
            if (resDiagGAS && resDiagGAS.diagramas) {
                resDiagGAS.diagramas.forEach(d => { dictDiasGAS[d.nom.trim().toLowerCase()] = d.dias; });
            }

            diagramasHibridos = choferes.map(chofer => {
                const nomNorm = normalizar(chofer.nombre);
                return {
                    _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"),
                    nom: chofer.nombre, tractor: chofer.units ? (chofer.units.tractor || '') : '',
                    semi: chofer.units ? (chofer.units.semi || '') : '', srv: chofer.c_servicio || '',
                    n_ute: chofer.units ? (chofer.units.n_ute || '') : '', td: '-', 
                    hex1: "", hex2: "", hex_1: "#ffffff", hex_2: "#ffffff", dias: dictDiasGAS[nomNorm] || {} 
                };
            });
        }

        let resDiag = { diagramas: diagramasHibridos };
        if (resDiagGAS && resDiagGAS.documentos) resDiag.documentos = resDiagGAS.documentos;
        if (resDiagGAS && resDiagGAS.habilitaciones) resDiag.habilitaciones = resDiagGAS.habilitaciones;
        if (resDiagGAS && resDiagGAS.certificados) resDiag.certificados = resDiagGAS.certificados;
        
        resDiag.nuevaSeccionViajes = nuevaSeccionViajes; 

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs || cacheDatosGlobales.tds || {};
        cacheDatosGlobales.nombresMesActual = resNombresMes || [];
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        io.emit('datos_actualizados', cacheDatosGlobales);

    } catch (error) {
        console.error("Error crítico general:", error);
    }
}

// ==========================================
// 🔔 3. RECEPTORES DE WEBHOOKS
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    res.json({ success: true, message: "Recibido" }); 

    const evento = req.body.evento || 'TODO';
    try {
        if (evento === 'KM') {
            flujoEncoladoKM(); // 🌟 Enviado a la cola blindada
        } 
        else if (evento === 'TD') {
            const nuevosTDs = await fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs');
            cacheDatosGlobales.tds = nuevosTDs || cacheDatosGlobales.tds;
            cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
            io.emit('datos_actualizados', cacheDatosGlobales);
            console.log(`✅ Socket emitido tras webhook de TD`);
        } 
        else {
            flujoEncoladoGlobal(); // 🌟 Enviado a la cola blindada
        }
    } catch (error) {
        console.error("❌ Error procesando el webhook:", error);
    }
});

app.post('/api/webhook/supabase', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.SUPABASE_WEBHOOK_SECRET || 'Mayo2026'}`) {
        return res.status(403).json({ error: "No autorizado" });
    }

    res.json({ success: true, message: "Recibido por Node" }); 
    const payload = req.body;

    try {
        const tablasMonitoreadas = ['choferes', 'units', 'documentos_choferes', 'movimientos', 'estados_diarios', 'registros_viajes_km'];
        if (tablasMonitoreadas.includes(payload.table)) {
            flujoEncoladoGlobal(); // 🌟 Enviado a la cola blindada
        }
    } catch (error) {
        console.error("❌ Error procesando webhook de Supabase:", error);
    }
});

// ==========================================
// 4. RUTAS DE LA API Y PROXY
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;
        if (body && body.action === 'guardarDocumentos') {
            const { nombre, exVen, licVen, certVen } = body;
            const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', nombre).single();

            if (choferData) {
                await supabase.from('documentos_choferes').upsert({ 
                    chofer_id: choferData.id, venc_periodico: exVen || null, venc_licencia: licVen || null, venc_cert_mp: certVen || null
                }, { onConflict: 'chofer_id' });
            }
            fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
            return res.json({ success: true, message: "Documentos sincronizados." });
        }

        const respuestaGoogle = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());

        if (body && body.action !== 'login') {
            flujoEncoladoGlobal(); // 🌟 Refresco seguro
        }
        res.json(respuestaGoogle);

    } catch (error) {
        res.status(500).json({ success: false, error: "Fallo en la DB" });
    }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor Híbrido (OOM-Proof) corriendo en puerto ${PORT}`));
