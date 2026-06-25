const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const { sincronizarTractoresContinuo } = require('./sincronizadorFlota'); 

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. CONFIGURACIÓN E INSTANCIAS
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const ID_SPREADSHEET_MASTER = process.env.SPREADSHEET_ID;
const ID_SPREADSHEET_DIAGRAMAS = '1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU';
const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

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

// 🚀 ARRANQUE INICIAL
setTimeout(() => { 
    sincronizarTractoresContinuo(); 
    flujoEncoladoGlobal(); 
}, 5000); 

setInterval(async () => { 
    const flotaCambio = await sincronizarTractoresContinuo(); 
    if (flotaCambio) {
        console.log("🔄 Se actualizaron tractores en DB. Forzando recarga de RAM...");
        flujoEncoladoGlobal(); 
    }
}, 5 * 60 * 1000); 

// ==========================================
// 🧠 2. EL CEREBRO: SINCRONIZACIÓN TOTAL (SHEETS + SUPABASE)
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("🔄 Sincronizando datos: Google Sheets + Supabase...");
        
        const docMaster = new GoogleSpreadsheet(ID_SPREADSHEET_MASTER, serviceAccountAuth);
        const docDiag = new GoogleSpreadsheet(ID_SPREADSHEET_DIAGRAMAS, serviceAccountAuth);

        await Promise.all([docMaster.loadInfo(), docDiag.loadInfo()]);

        const sheetCacheBasico = docMaster.sheetsByTitle['API_CACHE_BASICO']; 
        const sheetNombres = docMaster.sheetsByTitle['API_CACHE_NOMBRES']; 
        const sheetTDs = docMaster.sheetsByTitle['API_CACHE_TDS']; 
        const sheetObservaciones = docMaster.sheetsByTitle['OBSERVACIONES']; 

        await Promise.all([
            sheetCacheBasico ? sheetCacheBasico.loadCells('A1:Z15') : Promise.resolve(),
            sheetNombres ? sheetNombres.loadCells('A1:Z5') : Promise.resolve(),
            sheetTDs ? sheetTDs.loadCells('A1:Z15') : Promise.resolve(),
            sheetObservaciones ? sheetObservaciones.loadCells('A1:Z5') : Promise.resolve()
        ]);

        const extraerJsonDeFila = (sheet, filaIndex) => {
            if (!sheet) return null;
            let strCompleto = '';
            for (let col = 0; col < 26; col++) {
                try {
                    let cell = sheet.getCell(filaIndex, col);
                    if (cell && cell.value) strCompleto += String(cell.value).replace(/^'/, "");
                    else break;
                } catch(e) { break; }
            }
            if (!strCompleto) return null;
            try { return JSON.parse(strCompleto); } catch (e) { return null; }
        };

        let resDiagGAS = {
            diagramas: extraerJsonDeFila(sheetCacheBasico, 0) || [],
            documentos: extraerJsonDeFila(sheetCacheBasico, 1) || {},
            habilitaciones: extraerJsonDeFila(sheetCacheBasico, 2) || {},
            dnis: extraerJsonDeFila(sheetCacheBasico, 3) || {},
            certificados: extraerJsonDeFila(sheetCacheBasico, 4) || {},
            telefonos: extraerJsonDeFila(sheetCacheBasico, 5) || {},
            vencimientosObj: extraerJsonDeFila(sheetCacheBasico, 10) || {},
            observaciones: extraerJsonDeFila(sheetObservaciones, 0) || {},
            aptosMedicos: extraerJsonDeFila(sheetObservaciones, 1) || {}
        };
        let resTDs = extraerJsonDeFila(sheetTDs, 0) || {};

        try {
            if (sheetCacheBasico) sheetCacheBasico.resetLocalCache();
            if (sheetNombres) sheetNombres.resetLocalCache();
            if (sheetTDs) sheetTDs.resetLocalCache();
            if (sheetObservaciones) sheetObservaciones.resetLocalCache();
        } catch (e) {}

        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        // 👉 1. TRAEMOS CHOFERES DE SUPABASE
        const { data: choferes } = await supabase.from('choferes').select('*, units(n_ute, tractor, semi)');
        const mapaNombresId = {};
        
        let docsMap = resDiagGAS.documentos;
        let habsMap = resDiagGAS.habilitaciones;
        let certsMap = resDiagGAS.certificados;
        let dnisMap = resDiagGAS.dnis;
        let telefonosMap = resDiagGAS.telefonos;

        if (choferes) {
            choferes.forEach(c => { 
                const nomNorm = normalizar(c.nombre);
                mapaNombresId[c.id] = nomNorm; 
                if (c.dni) dnisMap[nomNorm] = { dni: c.dni };
                
                let datosContacto = telefonosMap[nomNorm] || {};
                if (c.telefono) datosContacto.telefono = c.telefono;
                if (c.legajo) datosContacto.legajo = c.legajo;
                if (c.email) datosContacto.email = c.email;
                telefonosMap[nomNorm] = datosContacto;
                if (c.dni) telefonosMap[c.dni] = datosContacto;
            });
        }

        const fechaLimite = new Date();
        fechaLimite.setDate(fechaLimite.getDate() - 365); 
        const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];

        // 👉 2. LEEMOS LOS CALENDARIOS DE GOOGLE SHEETS
        let diasLegacyIso = {}; 
        let srvLegacy = {};
        let visualesLegacyMap = {}; 

        let hoy = new Date();
        let offsetsMeses = [-1, 0, 1, 2, 3]; 
        let hojasInfo = [];

        const mapaHojasDiag = {};
        docDiag.sheetsByIndex.forEach(sheet => {
            try { mapaHojasDiag[sheet.title] = sheet; } catch(e) {}
        });

        for (let i of offsetsMeses) {
            let d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
            let anio = d.getFullYear();
            let mesStr = String(d.getMonth() + 1).padStart(2, '0');
            let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2);
            
            hojasInfo.push({ nombre: nombreHoja, anio, mesStr });
            
            let sheetDiag = mapaHojasDiag[nombreHoja]; 
            if (!sheetDiag) continue;
            
            try { await sheetDiag.loadCells('A1:AL255'); } 
            catch (boundsError) { try { await sheetDiag.loadCells(); } catch(e) { continue; } }
            
            for (let r = 5; r < 254; r++) { 
                try {
                    let cellNombre;
                    try { cellNombre = sheetDiag.getCell(r, 1).value; } catch(err) { continue; } 
                    if (!cellNombre || cellNombre === "APELLIDO Y NOMBRE" || cellNombre === "Personal Activo") continue;
                    
                    let nomNorm = normalizar(cellNombre);
                    if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};
                    
                    try {
                        let srv = sheetDiag.getCell(r, 2).value;
                        if (srv) srvLegacy[nomNorm] = String(srv).trim();
                    } catch(err) {}
                    
                    for (let dia = 1; dia <= 31; dia++) {
                        try {
                            let estado = sheetDiag.getCell(r, dia + 3).value;
                            if (estado && estado !== '-') {
                                let isoDate = `${anio}-${mesStr}-${String(dia).padStart(2, '0')}`;
                                diasLegacyIso[nomNorm][isoDate] = String(estado).toUpperCase().trim();
                            }
                        } catch(err) {} 
                    }
                } catch (e) { continue; } 
            }
            try { sheetDiag.resetLocalCache(); } catch(e) {}
        }

        // 👉 3. LEEMOS SUPABASE (Para no perder viajes web y diagramas web)
        let registrosViajesSQL = [];
        let diagramasSQL = [];
        let masViajes = true, masDiag = true;
        let pagV = 0, pagD = 0;

        while (masViajes) {
            const { data: chunk } = await supabase.from('registros_viajes_km').select('*').gte('fecha', fechaLimiteStr).range(pagV * 1000, (pagV + 1) * 1000 - 1);
            if (chunk && chunk.length > 0) { registrosViajesSQL.push(...chunk); pagV++; if (chunk.length < 1000) masViajes = false; } else masViajes = false;
        }

        while (masDiag) {
            const { data: chunkD } = await supabase.from('diagramas_diarios').select('*').gte('fecha', fechaLimiteStr).range(pagD * 1000, (pagD + 1) * 1000 - 1);
            if (chunkD && chunkD.length > 0) { diagramasSQL.push(...chunkD); pagD++; if (chunkD.length < 1000) masDiag = false; } else masDiag = false;
        }

        let nuevaSeccionViajes = {};
        registrosViajesSQL.forEach(row => {
            const choferNorm = mapaNombresId[row.chofer_id];
            if (!choferNorm) return; 
            if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
            const fechaLimpia = String(row.fecha).split('T')[0];
            nuevaSeccionViajes[choferNorm][fechaLimpia] = {
                dominio: row.dominio || '', km: Number(row.km || 0), 
                liviano: Number(row.liviano || 0), euro: Number(row.euro || 0),
                campo: Number(row.campo || 0), infiniaD: Number(row.infinia_d || 0), hoja_ruta: row.hoja_ruta || []
            };
        });

        const dictDiasSQL = {};
        diagramasSQL.forEach(row => {
            const choferNorm = mapaNombresId[row.chofer_id];
            if (!choferNorm) return;
            if (!dictDiasSQL[choferNorm]) dictDiasSQL[choferNorm] = {};
            dictDiasSQL[choferNorm][String(row.fecha).split('T')[0]] = row.estado;
        });

        const { data: documentosSQL } = await supabase.from('documentos_choferes').select('*');
        if (documentosSQL) {
            documentosSQL.forEach(doc => {
                const choferNorm = mapaNombresId[doc.chofer_id];
                if (choferNorm) {
                    if (doc.venc_periodico) docsMap[choferNorm] = { ven: String(doc.venc_periodico).split('T')[0], estado: 'OK' };
                    if (doc.venc_licencia) habsMap[choferNorm] = { ven: String(doc.venc_licencia).split('T')[0], estado: 'OK' };
                    if (doc.venc_cert_mp) certsMap[choferNorm] = { ven: String(doc.venc_cert_mp).split('T')[0], estado: 'OK' };
                }
            });
        }

        // 👉 4. TRADUCTOR FINAL: Mezcla ISO y conversión a Comas
        let diagramasHibridos = [];
        let choferesProcesados = new Set(); 

        const arrayTDsOriginal = resDiagGAS.diagramas || []; 
        arrayTDsOriginal.forEach(d => {
            let n = normalizar(d.nom);
            visualesLegacyMap[n] = { td: d.td, hex1: d.hex1, hex2: d.hex2, hex_1: d.hex_1, hex_2: d.hex_2 };
        });

        if (choferes) {
            choferes.forEach(chofer => {
                const nombreReal = String(chofer.nombre || '').trim();
                const nomNorm = normalizar(nombreReal);
                
                if (!nombreReal || choferesProcesados.has(nomNorm)) return;
                choferesProcesados.add(nomNorm);

                let unTractor = '', unSemi = '', unUte = '';
                if (chofer.units) {
                    let u = Array.isArray(chofer.units) ? chofer.units[0] : chofer.units;
                    if (u) { unTractor = u.tractor || ''; unSemi = u.semi || ''; unUte = u.n_ute || ''; }
                }

                let mergeIso = { ...(diasLegacyIso[nomNorm] || {}), ...(dictDiasSQL[nomNorm] || {}) };
                let vL = visualesLegacyMap[nomNorm] || {};

                let diasFront = {};
                hojasInfo.forEach(info => {
                    let tira = [];
                    for (let dia = 1; dia <= 31; dia++) {
                        let isoDate = `${info.anio}-${info.mesStr}-${String(dia).padStart(2, '0')}`;
                        tira.push(mergeIso[isoDate] || "-");
                    }
                    diasFront[info.nombre] = tira.join(",");
                });

                diagramasHibridos.push({
                    _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"), 
                    nom: nombreReal, 
                    tractor: unTractor, 
                    semi: unSemi, 
                    srv: srvLegacy[nomNorm] || chofer.c_servicio || '', 
                    n_ute: unUte, 
                    td: vL.td || '-', 
                    hex1: vL.hex1 || "", hex2: vL.hex2 || "", hex_1: vL.hex_1 || "#ffffff", hex_2: vL.hex_2 || "#ffffff", 
                    dias: diasFront,       
                    _diasIso: mergeIso     
                });
            });
        }

        cacheDatosGlobales.diagramas = { 
            diagramas: diagramasHibridos, nuevaSeccionViajes,
            documentos: docsMap, habilitaciones: habsMap, certificados: certsMap,
            dnis: dnisMap, telefonos: telefonosMap,
            observaciones: resDiagGAS.observaciones, aptosMedicos: resDiagGAS.aptosMedicos, vencimientosObj: resDiagGAS.vencimientosObj
        };

        cacheDatosGlobales.tds = resTDs;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        io.emit('datos_actualizados', cacheDatosGlobales);
        console.log(`✅ Sincronización completa. Sockets emitidos.`);
    } catch (error) { console.error("❌ Error en ensamblador directo:", error); }
}

function obtenerInfoHojaDesdeIso(isoDate) {
    let d = new Date(isoDate + "T12:00:00");
    let anio = d.getFullYear();
    let mesStr = String(d.getMonth() + 1).padStart(2, '0');
    let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2);
    return { nombre: nombreHoja, anio, mesStr };
}

// ==========================================
// 🔔 3. RECEPTORES DE WEBHOOKS
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    res.json({ success: true, message: "Recibido" }); 
    // 🔥 Ahora ante cualquier evento disparamos la lectura global
    flujoEncoladoGlobal(); 
});

// ==========================================
// 🌟 4. RUTAS API Y PROXY (MUTACIÓN ISO + FRONTEND)
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;
        let huboCambios = false;
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        // 🔐 1. MÓDULO DE LOGIN (Independiente de Google)
        if (body && body.action === 'login') {
            const { data: user, error } = await supabase
                .from('usuarios_auth')
                .select('id, usuario, rol')
                .eq('usuario', body.usuario)
                .eq('password', body.password)
                .single();

            if (user) {
                // Login Exitoso: Devolvemos un Token para el Front-End
                return res.json({ 
                    success: true, 
                    token: 'auth_' + user.id + '_' + Date.now(), 
                    rol: user.rol 
                });
            } else {
                // Falla el Login
                return res.json({ 
                    success: false, 
                    error: "Usuario o contraseña incorrectos." 
                });
            }
        }

        // 📄 2. GUARDADO DE DOCUMENTOS
        if (body && body.action === 'guardarDocumentos') {
            const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', body.nombre).single();
            if (choferData) {
                await supabase.from('documentos_choferes').upsert({ chofer_id: choferData.id, venc_periodico: body.exVen, venc_licencia: body.licVen, venc_cert_mp: body.certVen }, { onConflict: 'chofer_id' });
                
                let choferNorm = normalizar(body.nombre);
                if (!cacheDatosGlobales.diagramas.documentos) cacheDatosGlobales.diagramas.documentos = {};
                if (!cacheDatosGlobales.diagramas.habilitaciones) cacheDatosGlobales.diagramas.habilitaciones = {};
                if (!cacheDatosGlobales.diagramas.certificados) cacheDatosGlobales.diagramas.certificados = {};
                
                if (body.exVen) cacheDatosGlobales.diagramas.documentos[choferNorm] = { ven: body.exVen, estado: 'OK' };
                if (body.licVen) cacheDatosGlobales.diagramas.habilitaciones[choferNorm] = { ven: body.licVen, estado: 'OK' };
                if (body.certVen) cacheDatosGlobales.diagramas.certificados[choferNorm] = { ven: body.certVen, estado: 'OK' };
                huboCambios = true;
            }
        }

        // 🚚 3. GUARDADO DE VIAJES Y HOJAS DE RUTA
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

                    let choferNorm = normalizar(nomChofer);
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes) cacheDatosGlobales.diagramas.nuevaSeccionViajes = {};
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[choferNorm]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[choferNorm] = {};
                    
                    let vEx = cacheDatosGlobales.diagramas.nuevaSeccionViajes[choferNorm][fechaViaje] || {};
                    cacheDatosGlobales.diagramas.nuevaSeccionViajes[choferNorm][fechaViaje] = {
                        dominio: body.dominio !== undefined ? body.dominio : (vEx.dominio || ''), km: body.km !== undefined ? Number(body.km) : (vEx.km || 0),
                        liviano: body.liviano !== undefined ? Number(body.liviano) : (vEx.liviano || 0), euro: body.euro !== undefined ? Number(body.euro) : (vEx.euro || 0),
                        campo: body.campo !== undefined ? Number(body.campo) : (vEx.campo || 0), infiniaD: body.infinia_d !== undefined ? Number(body.infinia_d) : (vEx.infiniaD || 0),
                        hoja_ruta: body.hoja_ruta !== undefined ? body.hoja_ruta : (vEx.hoja_ruta || [])
                    };
                    huboCambios = true;
                }
            }
        }

        // 📅 4. ACTUALIZACIÓN DE ESTADO EN EL CALENDARIO
        if (body && body.action === 'actualizarEstado') {
            const nomChofer = body.nombre; const startIso = body.startIso; const endIso = body.endIso; const estPayload = body.est;

            if (nomChofer && startIso && endIso) {
                const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', nomChofer).single();
                
                if (choferData) {
                    let dStart = new Date(startIso + "T12:00:00"); let dEnd = new Date(endIso + "T12:00:00");
                    let current = new Date(dStart); let dayIndex = 0; let arrayParaUpsert = [];

                    let choferNorm = normalizar(nomChofer);
                    let idxChoferRAM = cacheDatosGlobales.diagramas.diagramas ? cacheDatosGlobales.diagramas.diagramas.findIndex(d => normalizar(d.nom) === choferNorm) : -1;
                    let mesesAfectados = new Set();

                    while (current <= dEnd) {
                        let fechaDia = current.toISOString().split('T')[0];
                        let estadoDia = Array.isArray(estPayload) ? (estPayload[dayIndex] || '') : estPayload;

                        let infoHoja = obtenerInfoHojaDesdeIso(fechaDia);
                        mesesAfectados.add(infoHoja);

                        if (estadoDia === 'BORRAR' || estadoDia === '' || estadoDia === null || estadoDia === '-') {
                            await supabase.from('diagramas_diarios').delete().match({ chofer_id: choferData.id, fecha: fechaDia });
                            if (idxChoferRAM !== -1 && cacheDatosGlobales.diagramas.diagramas[idxChoferRAM]._diasIso) {
                                delete cacheDatosGlobales.diagramas.diagramas[idxChoferRAM]._diasIso[fechaDia];
                            }
                        } else {
                            let limpio = String(estadoDia).toUpperCase().trim();
                            arrayParaUpsert.push({ chofer_id: choferData.id, fecha: fechaDia, estado: limpio, actualizado_en: new Date() });
                            if (idxChoferRAM !== -1) {
                                if (!cacheDatosGlobales.diagramas.diagramas[idxChoferRAM]._diasIso) cacheDatosGlobales.diagramas.diagramas[idxChoferRAM]._diasIso = {};
                                cacheDatosGlobales.diagramas.diagramas[idxChoferRAM]._diasIso[fechaDia] = limpio;
                            }
                        }
                        current.setDate(current.getDate() + 1); dayIndex++;
                    }

                    if (arrayParaUpsert.length > 0) await supabase.from('diagramas_diarios').upsert(arrayParaUpsert, { onConflict: 'chofer_id,fecha' });

                    if (idxChoferRAM !== -1) {
                        mesesAfectados.forEach(info => {
                            let tira = [];
                            for(let d=1; d<=31; d++){
                                let isoD = `${info.anio}-${info.mesStr}-${String(d).padStart(2,'0')}`;
                                tira.push(cacheDatosGlobales.diagramas.diagramas[idxChoferRAM]._diasIso[isoD] || "-");
                            }
                            cacheDatosGlobales.diagramas.diagramas[idxChoferRAM].dias[info.nombre] = tira.join(",");
                        });
                    }
                    huboCambios = true;
                }
            }
        }

        const REPLICAR_EN_GOOGLE = false; 

        if (REPLICAR_EN_GOOGLE) {
            try { await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) }); } 
            catch (err) {}
        }

        // Emitimos la actualización por Sockets a todos (excepto si fue solo login)
        if (body && body.action !== 'login' && huboCambios) {
            cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
            io.emit('datos_actualizados', cacheDatosGlobales); 
        }

        res.json({ success: true, message: "Guardado en SQL y RAM actualizada." });

    } catch (error) { console.error(error); res.status(500).json({ success: false, error: "Fallo general en Proxy" }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Node Activo en puerto ${PORT}`));
