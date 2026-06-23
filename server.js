const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const { sincronizarTractoresContinuo } = require('./sincronizadorFlota'); 
const { sincronizarViajesASupabase } = require('./sincronizadorViajes'); // (Para micro-sync si alguien toca el Excel)

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

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

const fetchSeguro = async (url) => {
    try {
        const r = await fetch(url);
        const text = await r.text();
        if (text.trim().startsWith('<')) return null;
        return JSON.parse(text);
    } catch (err) { return null; }
};

// ==========================================
// 🛡️ SISTEMA DE COLAS Y WORKERS
// ==========================================
let ejecutandoGlobal = false;
let pendienteGlobal = false;

async function flujoEncoladoGlobal() {
    if (ejecutandoGlobal) { pendienteGlobal = true; return; }
    ejecutandoGlobal = true;
    try { await actualizarCacheDesdeGoogle(); } 
    finally {
        ejecutandoGlobal = false;
        if (pendienteGlobal) { pendienteGlobal = false; flujoEncoladoGlobal(); }
    }
}

let ejecutandoKM = false;
let pendienteKM = false;

async function flujoEncoladoKM() {
    if (ejecutandoKM) { pendienteKM = true; return; }
    ejecutandoKM = true;
    try {
        await sincronizarViajesASupabase(2);
        await actualizarCacheDesdeGoogle();
    } finally {
        ejecutandoKM = false;
        if (pendienteKM) { pendienteKM = false; flujoEncoladoKM(); }
    }
}

// Iniciar procesos en segundo plano
setTimeout(() => {
    sincronizarTractoresContinuo();
    flujoEncoladoGlobal(); 
}, 5000); 

setInterval(() => {
    sincronizarTractoresContinuo();
}, 5 * 60 * 1000); 

// ==========================================
// 🧠 2. EL CEREBRO: ENSAMBLADOR EN RAM (SQL -> JSON)
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("🔄 Reconstruyendo Memoria RAM (SQL + Google)...");
        
        const [resDiagGAS, resNombresMes, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`)
        ]);

        const { data: choferes } = await supabase.from('choferes').select('id, nombre, c_servicio, units(n_ute, tractor, semi)');
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
        const mapaNombresId = {};
        if (choferes) choferes.forEach(c => { mapaNombresId[c.id] = normalizar(c.nombre); });

        const fechaLimite = new Date();
        fechaLimite.setDate(fechaLimite.getDate() - 365); 
        const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];

        // --- LECTURA A: VIAJES (KMs) ---
        let registrosViajesSQL = [];
        let masViajes = true;
        let pagV = 0;
        while (masViajes) {
            const { data: chunk } = await supabase.from('registros_viajes_km').select('*').gte('fecha', fechaLimiteStr).range(pagV * 1000, (pagV + 1) * 1000 - 1);
            if (chunk && chunk.length > 0) { registrosViajesSQL.push(...chunk); pagV++; if (chunk.length < 1000) masViajes = false; } 
            else { masViajes = false; }
        }

        let nuevaSeccionViajes = {};
        if (registrosViajesSQL.length > 0) {
            registrosViajesSQL.forEach(row => {
                const choferNorm = mapaNombresId[row.chofer_id];
                if (!choferNorm) return; 
                if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                const fechaLimpia = String(row.fecha).split('T')[0];
                nuevaSeccionViajes[choferNorm][fechaLimpia] = {
                    dominio: row.dominio || '', km: Number(row.km || 0), 
                    liviano: Number(row.liviano || 0), euro: Number(row.euro || 0),
                    campo: Number(row.campo || 0), infiniaD: Number(row.infinia_d || 0), 
                    hoja_ruta: row.hoja_ruta || []
                };
            });
        }

        // --- LECTURA B: DIAGRAMAS DIARIOS (Estados F, V, L) ---
        let diagramasSQL = [];
        let masDiag = true;
        let pagD = 0;
        while (masDiag) {
            const { data: chunkD } = await supabase.from('diagramas_diarios').select('*').gte('fecha', fechaLimiteStr).range(pagD * 1000, (pagD + 1) * 1000 - 1);
            if (chunkD && chunkD.length > 0) { diagramasSQL.push(...chunkD); pagD++; if (chunkD.length < 1000) masDiag = false; } 
            else { masDiag = false; }
        }

        const dictDiasSQL = {};
        if (diagramasSQL.length > 0) {
            diagramasSQL.forEach(row => {
                const choferNorm = mapaNombresId[row.chofer_id];
                if (!choferNorm) return;
                if (!dictDiasSQL[choferNorm]) dictDiasSQL[choferNorm] = {};
                const fechaLimpia = String(row.fecha).split('T')[0];
                dictDiasSQL[choferNorm][fechaLimpia] = row.estado;
            });
        }

        // --- ENSAMBLADO FINAL ---
        let diagramasHibridos = [];
        if (choferes) {
            diagramasHibridos = choferes.map(chofer => {
                const nomNorm = normalizar(chofer.nombre);
                return {
                    _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"), nom: chofer.nombre, 
                    tractor: chofer.units ? (chofer.units.tractor || '') : '', semi: chofer.units ? (chofer.units.semi || '') : '', 
                    srv: chofer.c_servicio || '', n_ute: chofer.units ? (chofer.units.n_ute || '') : '', td: '-', 
                    hex1: "", hex2: "", hex_1: "#ffffff", hex_2: "#ffffff", 
                    dias: dictDiasSQL[nomNorm] || {} // 🌟 INYECTAMOS DIRECTO DESDE SQL
                };
            });
        }

        let resDiag = { diagramas: diagramasHibridos, nuevaSeccionViajes };
        if (resDiagGAS && resDiagGAS.documentos) resDiag.documentos = resDiagGAS.documentos;
        if (resDiagGAS && resDiagGAS.habilitaciones) resDiag.habilitaciones = resDiagGAS.habilitaciones;
        if (resDiagGAS && resDiagGAS.certificados) resDiag.certificados = resDiagGAS.certificados;

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs || cacheDatosGlobales.tds || {};
        cacheDatosGlobales.nombresMesActual = resNombresMes || [];
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        io.emit('datos_actualizados', cacheDatosGlobales);
        console.log(`✅ RAM lista y Sockets emitidos.`);
    } catch (error) { console.error("❌ Error en ensamblador:", error); }
}

// ==========================================
// 🔔 3. RECEPTORES DE WEBHOOKS (SOLO DESDE GOOGLE SHEETS)
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    res.json({ success: true, message: "Recibido" }); 
    const evento = req.body.evento || 'TODO';
    
    if (evento === 'KM') {
        flujoEncoladoKM(); // Micro-sync por si tocan el Excel a mano
    } else if (evento === 'TD') {
        const nuevosTDs = await fetchSeguro(`${GAS_URL}?action=obtenerTDs`);
        cacheDatosGlobales.tds = nuevosTDs || cacheDatosGlobales.tds;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        io.emit('datos_actualizados', cacheDatosGlobales);
    } else { 
        flujoEncoladoGlobal(); 
    }
});

// ==========================================
// 🌟 4. RUTAS API Y PROXY (ESCRITURA DIRECTA)
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;
        let huboCambios = false; // 🚩 Bandera para disparar el Socket al final

        // A. DOCUMENTOS
        if (body && body.action === 'guardarDocumentos') {
            const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', body.nombre).single();
            if (choferData) {
                await supabase.from('documentos_choferes').upsert({ chofer_id: choferData.id, venc_periodico: body.exVen, venc_licencia: body.licVen, venc_cert_mp: body.certVen }, { onConflict: 'chofer_id' });
            }
            huboCambios = true;
        }

        // B. VIAJES Y KMs
        if (body && (body.action === 'guardarHojasRuta' || body.action === 'guardarViaje' || body.action === 'actualizarViaje' || body.hoja_ruta !== undefined || body.km !== undefined)) {
            const nomChofer = body.nombre || body.nom || body.chofer;
            const fechaViaje = body.fecha || body.isoDate;

            if (nomChofer && fechaViaje) {
                const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', nomChofer).single();
                if (choferData) {
                    const { data: viajeExistente } = await supabase.from('registros_viajes_km').select('*').eq('chofer_id', choferData.id).eq('fecha', fechaViaje).single();
                    await supabase.from('registros_viajes_km').upsert({
                        chofer_id: choferData.id, fecha: fechaViaje,
                        dominio: body.dominio !== undefined ? body.dominio : (viajeExistente?.dominio || null),
                        km: body.km !== undefined ? body.km : (viajeExistente?.km || 0),
                        liviano: body.liviano !== undefined ? body.liviano : (viajeExistente?.liviano || 0),
                        euro: body.euro !== undefined ? body.euro : (viajeExistente?.euro || 0),
                        campo: body.campo !== undefined ? body.campo : (viajeExistente?.campo || 0),
                        infinia_d: body.infinia_d !== undefined ? body.infinia_d : (viajeExistente?.infinia_d || 0),
                        hoja_ruta: body.hoja_ruta !== undefined ? body.hoja_ruta : (viajeExistente?.hoja_ruta || []),
                        actualizado_en: new Date()
                    }, { onConflict: 'chofer_id,fecha' });
                    huboCambios = true;
                }
            }
        }

        // C. 🌟 DIAGRAMAS (Letras F, V, L)
        if (body && (body.action === 'editarCelda' || body.estado !== undefined)) {
            const nomChofer = body.nombre || body.nom || body.chofer;
            const fechaDia = body.fecha || body.isoDate;
            const estadoDia = body.estado || body.valor;

            if (nomChofer && fechaDia) {
                const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', nomChofer).single();
                if (choferData) {
                    if (estadoDia === '' || estadoDia === null || estadoDia === '-') {
                        await supabase.from('diagramas_diarios').delete().match({ chofer_id: choferData.id, fecha: fechaDia });
                    } else {
                        await supabase.from('diagramas_diarios').upsert({
                            chofer_id: choferData.id, fecha: fechaDia, estado: String(estadoDia).toUpperCase().trim(), actualizado_en: new Date()
                        }, { onConflict: 'chofer_id,fecha' });
                    }
                    huboCambios = true;
                }
            }
        }

        // =========================================================
        // 🚧 MÓDULO AISLADO: RÉPLICA EN GOOGLE SHEETS (LEGACY)
        // =========================================================
        
        // 🚩 Cambiar a 'true' si algún día necesitas que la web vuelva a escribir en Excel
        const REPLICAR_EN_GOOGLE = false; 

        // Respuesta simulada inmediata para que la Web no se quede esperando
        let respuestaFrontend = { success: true, message: "Guardado rápido en SQL" };

        if (REPLICAR_EN_GOOGLE) {
            try {
                // Esta línea bloqueaba el sistema por 3 segundos. Ahora está en cuarentena.
                respuestaFrontend = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
            } catch (err) {
                console.error("⚠️ Fallo en la réplica de Google Sheets:", err.message);
            }
        }

        // =========================================================
        // 🚀 EMITIR CAMBIOS Y RESPONDER A LA WEB AL INSTANTE
        // =========================================================
        
        if (body && body.action !== 'login' && huboCambios) {
            flujoEncoladoGlobal(); // Dispara la recarga en RAM de Render y emite a los demás usuarios
        }

        // Devolvemos la respuesta al usuario en < 0.1 segundos
        res.json(respuestaFrontend);

    } catch (error) { 
        res.status(500).json({ success: false, error: "Fallo general en Proxy SQL" }); 
    }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Central SQL Activo en puerto ${PORT}`));
