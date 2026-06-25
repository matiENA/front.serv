const express = require('express');
const compression = require('compression');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(compression()); 

const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));

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
const ID_SHEET_OBSERVACIONES = '1VwCNK89ecaac7IDlMWWCLHRqZoch9HB6vop5AfQEaA0';
const ID_SHEET_APTOS_MEDICOS = '1oJmN8hurfHfNnGBYUFcBdlrIj2VUzeIyq0ZTWxTpYNI';
const ID_SHEET_MOVIMIENTOS = '1hhJKwp9xOOHL_zZSJMbrJh5fwfsIPre155UTWhKWI44'; // Flota
const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

// ==========================================
// 🛡️ LECTOR ULTRALIVIANO (Evita Crash de RAM)
// ==========================================
async function fetchRango(spreadsheetId, rango) {
    try {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rango)}`;
        const res = await serviceAccountAuth.request({ url });
        return res.data.values || [];
    } catch (e) {
        console.warn(`⚠️ Error leyendo rango ${rango}:`, e.message);
        return [];
    }
}

// ==========================================
// 🛡️ SISTEMA DE COLAS INTELIGENTE
// ==========================================
let ejecutandoGlobal = false;
let pendienteGlobal = false;
let necesitaArranqueProfundo = true; 

async function flujoEncoladoGlobal(esArranque = false) {
    if (esArranque) necesitaArranqueProfundo = true;
    if (ejecutandoGlobal) { pendienteGlobal = true; return; }
    ejecutandoGlobal = true;

    try { 
        let hacerArranque = necesitaArranqueProfundo || cacheDatosGlobales.diagramas === null;
        necesitaArranqueProfundo = false; 
        await actualizarCacheDesdeGoogle(hacerArranque); 
    } 
    finally {
        ejecutandoGlobal = false;
        if (pendienteGlobal) { 
            pendienteGlobal = false; 
            flujoEncoladoGlobal(necesitaArranqueProfundo); 
        }
    }
}

// 🚀 ARRANQUE INICIAL (Se inicia casi al instante)
setTimeout(() => { 
    console.log("⏳ [Boot] Disparando evento inicial...");
    flujoEncoladoGlobal(true); 
}, 3000); 

// ==========================================
// 🧠 2. EL CEREBRO: CONSTRUCCIÓN NATIVA (API RAW)
// ==========================================
async function actualizarCacheDesdeGoogle(esArranque = false) {
    try {
        console.log(esArranque ? "🚀 ARRANQUE: Descarga Cruda (RAM Protegida)..." : "⚡ WEBHOOK: Actualizando RAM ligera...");
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        let resDiagGAS = {
            vencimientosObj: cacheDatosGlobales.diagramas?.vencimientosObj || [],
            fotosImgur: cacheDatosGlobales.diagramas?.fotosImgur || {},
            observaciones: cacheDatosGlobales.diagramas?.observaciones || {},
            aptosMedicos: cacheDatosGlobales.diagramas?.aptosMedicos || {},
            documentos: {}, habilitaciones: {}, dnis: {}, certificados: {}, telefonos: {}, flota: {} 
        };

        // 🩺 APTOS MÉDICOS (Lectura Cruda)
        const rowsAptos = await fetchRango(ID_SHEET_APTOS_MEDICOS, 'Seguimiento Avalados Mensual!A2:AT350');
        resDiagGAS.aptosMedicos = {};
        rowsAptos.forEach(row => {
            if(!row[0] || row[0] === "Nombre Completo") return;
            let norm = normalizar(row[0]);
            let estadoDiario = "-";
            for (let c = 45; c >= 12; c--) {
                if (row[c] && row[c].trim() !== "" && row[c].trim() !== "-") { estadoDiario = row[c].trim(); break; }
            }
            resDiagGAS.aptosMedicos[norm] = { 
                estado: estadoDiario, cuil: row[1] || "", 
                observaciones: row[10] || "", observaciones_sector_salud: row[11] || "", responsable: row[5] || "" 
            };
        });

        // 📝 OBSERVACIONES (Lectura Cruda)
        const rowsObs = await fetchRango(ID_SHEET_OBSERVACIONES, 'Movimientos!A5:H2000');
        resDiagGAS.observaciones = {};
        rowsObs.forEach(row => {
            if(!row[1]) return;
            let norm = normalizar(row[1]);
            if (!resDiagGAS.observaciones[norm]) resDiagGAS.observaciones[norm] = [];
            resDiagGAS.observaciones[norm].push({
                admin: row[0] || "-", fecha: row[2] || "-", unidad: row[3] || "-", evento: row[4] || "-",
                obsEvento: row[5] || "", estado: row[6] || "-", obsEstado: row[7] || ""
            });
        });

        // 🚚 FLOTA (Lectura Cruda)
        const rowsFlota = await fetchRango(ID_SPREADSHEET_MASTER, 'choferes y unidades!A2:E300');
        rowsFlota.forEach(row => {
            if(!row[0]) return;
            let norm = normalizar(row[0]);
            resDiagGAS.flota[norm] = { tractor: row[1] || '', semi: row[2] || '', servicio: row[3] || '', n_ute: row[4] || '' };
        });

        const rowsCache = await fetchRango(ID_SPREADSHEET_MASTER, 'API_CACHE_BASICO!A1:Z15');
        const extraer = (idx) => {
            if (!rowsCache[idx]) return {};
            try { return JSON.parse(rowsCache[idx].join('').replace(/^'/, "")); } catch(e) { return {}; }
        };
        resDiagGAS.documentos = extraer(1); resDiagGAS.habilitaciones = extraer(2);
        resDiagGAS.dnis = extraer(3); resDiagGAS.certificados = extraer(4); resDiagGAS.telefonos = extraer(5);

        let diasLegacyIso = {}; let srvLegacy = {}; let hojasInfo = [];

        if (esArranque) {
            // 📆 VENCIMIENTOS (Lectura Cruda)
            const rowsVenc = await fetchRango(ID_SHEET_MOVIMIENTOS, 'Vencimientos.!A2:N300');
            resDiagGAS.vencimientosObj = rowsVenc.map(row => {
                if (!row[1]) return null;
                return {
                    col_b: row[1] || "", col_c: row[2] || "", col_g: row[6] || "", col_h: row[7] || "",
                    col_j: row[9] || "", col_k: row[10] || "", col_l: row[11] || "", col_m: row[12] || "", col_n: row[13] || ""
                };
            }).filter(Boolean);

            // 📷 FOTOS (Lectura Cruda)
            const rowsFotos = await fetchRango(ID_SPREADSHEET_MASTER, 'fotos!A1:B200');
            resDiagGAS.fotosImgur = {};
            rowsFotos.forEach(row => {
                if (row[0] && row[1] && row[1].includes('http')) resDiagGAS.fotosImgur[row[0].replace(/\D/g, '')] = row[1].trim();
            });

            // 🗓️ DIAGRAMAS MENSUALES (Lectura Cruda secuencial)
            let hoy = new Date(); let offsetsMeses = [-1, 0, 1, 2, 3]; 
            for (let i of offsetsMeses) {
                let d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1); let anio = d.getFullYear(); let mesStr = String(d.getMonth() + 1).padStart(2, '0');
                let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2);
                hojasInfo.push({ nombre: nombreHoja, anio, mesStr });
                
                const rowsDiag = await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `${nombreHoja}!A6:AL255`);
                rowsDiag.forEach(row => {
                    let cellNombre = row[1];
                    if (!cellNombre || cellNombre === "APELLIDO Y NOMBRE" || cellNombre === "Personal Activo") return;
                    let nomNorm = normalizar(cellNombre); if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};
                    if (row[2]) srvLegacy[nomNorm] = String(row[2]).trim();
                    for (let dia = 1; dia <= 31; dia++) {
                        let estado = row[dia + 3];
                        if (estado && estado !== '-') { let isoDate = `${anio}-${mesStr}-${String(dia).padStart(2, '0')}`; diasLegacyIso[nomNorm][isoDate] = String(estado).toUpperCase().trim(); } 
                    }
                });
            }

            // 🗄️ SUPABASE
            const { data: choferes } = await supabase.from('choferes').select('id, nombre, dni, telefono, legajo, email, c_servicio');
            const mapaNombresId = {};
            let docsMap = resDiagGAS.documentos || {}; let habsMap = resDiagGAS.habilitaciones || {}; let certsMap = resDiagGAS.certificados || {};
            let dnisMap = resDiagGAS.dnis || {}; let telefonosMap = resDiagGAS.telefonos || {};

            if (choferes) {
                choferes.forEach(c => { 
                    const nomNorm = normalizar(c.nombre); mapaNombresId[c.id] = nomNorm; if (c.dni) dnisMap[nomNorm] = { dni: c.dni };
                    let datosContacto = telefonosMap[nomNorm] || {};
                    if (c.telefono) datosContacto.telefono = c.telefono; if (c.legajo) datosContacto.legajo = c.legajo; if (c.email) datosContacto.email = c.email;
                    telefonosMap[nomNorm] = datosContacto; if (c.dni) telefonosMap[c.dni] = datosContacto;
                });
            }

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

            const fechaLimiteStr = new Date(Date.now() - 365*24*60*60*1000).toISOString().split('T')[0];
            let registrosViajesSQL = []; let diagramasSQL = []; let masViajes = true, masDiag = true; let pagV = 0, pagD = 0;

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
                const choferNorm = mapaNombresId[row.chofer_id]; if (!choferNorm) return; 
                if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                nuevaSeccionViajes[choferNorm][String(row.fecha).split('T')[0]] = {
                    dominio: row.dominio || '', km: Number(row.km || 0), liviano: Number(row.liviano || 0), euro: Number(row.euro || 0),
                    campo: Number(row.campo || 0), infiniaD: Number(row.infinia_d || 0), hoja_ruta: row.hoja_ruta || []
                };
            });

            const dictDiasSQL = {};
            diagramasSQL.forEach(row => {
                const choferNorm = mapaNombresId[row.chofer_id]; if (!choferNorm) return;
                if (!dictDiasSQL[choferNorm]) dictDiasSQL[choferNorm] = {};
                dictDiasSQL[choferNorm][String(row.fecha).split('T')[0]] = row.estado;
            });

            let diagramasHibridos = []; let choferesProcesados = new Set(); 
            if (choferes) {
                choferes.forEach(chofer => {
                    const nombreReal = String(chofer.nombre || '').trim(); const nomNorm = normalizar(nombreReal);
                    if (!nombreReal || choferesProcesados.has(nomNorm)) return;
                    choferesProcesados.add(nomNorm);

                    let flota = resDiagGAS.flota[nomNorm] || {};
                    let mergeIso = { ...(diasLegacyIso[nomNorm] || {}), ...(dictDiasSQL[nomNorm] || {}) };
                    let diasFront = {};
                    hojasInfo.forEach(info => {
                        let tira = [];
                        for (let dia = 1; dia <= 31; dia++) { tira.push(mergeIso[`${info.anio}-${info.mesStr}-${String(dia).padStart(2, '0')}`] || "-"); }
                        diasFront[info.nombre] = tira.join(",");
                    });

                    diagramasHibridos.push({
                        _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"), nom: nombreReal, 
                        tractor: flota.tractor || '', semi: flota.semi || '', srv: flota.servicio || chofer.c_servicio || '', n_ute: flota.n_ute || '', 
                        td: '-', hex1: "", hex2: "", hex_1: "#ffffff", hex_2: "#ffffff", dias: diasFront, _diasIso: mergeIso     
                    });
                });
            }

            cacheDatosGlobales.diagramas = { 
                diagramas: diagramasHibridos, nuevaSeccionViajes, documentos: docsMap, habilitaciones: habsMap, certificados: certsMap,
                dnis: dnisMap, telefonos: telefonosMap, observaciones: resDiagGAS.observaciones, aptosMedicos: resDiagGAS.aptosMedicos, 
                vencimientosObj: resDiagGAS.vencimientosObj, fotosImgur: resDiagGAS.fotosImgur
            };

        } else {
            if (cacheDatosGlobales.diagramas) {
                cacheDatosGlobales.diagramas.observaciones = resDiagGAS.observaciones;
                cacheDatosGlobales.diagramas.aptosMedicos = resDiagGAS.aptosMedicos;
                if (cacheDatosGlobales.diagramas.diagramas) {
                    cacheDatosGlobales.diagramas.diagramas.forEach(d => {
                        let norm = normalizar(d.nom);
                        if (resDiagGAS.flota[norm]) {
                            d.tractor = resDiagGAS.flota[norm].tractor; d.semi = resDiagGAS.flota[norm].semi;
                            d.srv = resDiagGAS.flota[norm].servicio; d.n_ute = resDiagGAS.flota[norm].n_ute;
                        }
                    });
                }
            }
        }

        cacheDatosGlobales.tds = { campo:{}, infinia:{}, liviano:{}, euro:{}, estados:{}, codigosExtra:{} };
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        io.emit('datos_actualizados', cacheDatosGlobales);
        console.log(`✅ RAM sincronizada con consumo ultra bajo.`);
    } catch (error) { console.error("❌ Error en construcción de RAM:", error); }
}

function obtenerInfoHojaDesdeIso(isoDate) {
    let d = new Date(isoDate + "T12:00:00"); let anio = d.getFullYear(); let mesStr = String(d.getMonth() + 1).padStart(2, '0');
    let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2); return { nombre: nombreHoja, anio, mesStr };
}

// ==========================================
// 🔔 3. RECEPTORES DE WEBHOOKS
// ==========================================
app.post('/api/webhook/google', async (req, res) => { res.json({ success: true }); flujoEncoladoGlobal(false); });
app.get('/health', (req, res) => res.status(200).send('OK'));

// ==========================================
// 🌟 4. RUTAS API Y PROXY (MUTACIÓN ISO + FRONTEND)
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body; let huboCambios = false;
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        if (body && body.action === 'login') {
            const { data: user } = await supabase.from('usuarios_auth').select('id, usuario, rol').eq('usuario', body.usuario).eq('password', body.password).single();
            if (user) { return res.json({ success: true, token: 'auth_' + user.id + '_' + Date.now(), rol: user.rol }); } 
            else { return res.json({ success: false, error: "Usuario o contraseña incorrectos." }); }
        }

        if (body && (body.action === 'guardarObservacion' || body.action === 'guardarNuevaObservacion')) {
            const docObs = new GoogleSpreadsheet(ID_SHEET_OBSERVACIONES, serviceAccountAuth);
            await docObs.loadInfo(); const sheetMov = docObs.sheetsByTitle['Movimientos'];
            if (sheetMov) {
                const nuevaFila = [ body.usuario || body.admin || 'Sistema', body.chofer, body.fecha, body.unidad || "-", body.evento, body.obsEvento || "", body.estado || "-", body.obsEstado || "", "","","","","","","","" ];
                await sheetMov.addRow(nuevaFila); 
                let choferNorm = normalizar(body.chofer);
                if (!cacheDatosGlobales.diagramas.observaciones) cacheDatosGlobales.diagramas.observaciones = {};
                if (!cacheDatosGlobales.diagramas.observaciones[choferNorm]) cacheDatosGlobales.diagramas.observaciones[choferNorm] = [];
                cacheDatosGlobales.diagramas.observaciones[choferNorm].push({ admin: nuevaFila[0], fecha: nuevaFila[2], unidad: nuevaFila[3], evento: nuevaFila[4], obsEvento: nuevaFila[5], estado: nuevaFila[6], obsEstado: nuevaFila[7] });
                huboCambios = true;
            }
        }

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

        if (body && (body.action === 'guardarHojasRuta' || body.action === 'guardarViaje' || body.action === 'actualizarViaje' || body.hoja_ruta !== undefined || body.km !== undefined)) {
            const nomChofer = body.nombre || body.nom || body.chofer; const fechaViaje = body.fecha || body.isoDate;
            if (nomChofer && fechaViaje) {
                const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', nomChofer).single();
                if (choferData) {
                    const { data: viajeExistente } = await supabase.from('registros_viajes_km').select('*').eq('chofer_id', choferData.id).eq('fecha', fechaViaje).single();
                    await supabase.from('registros_viajes_km').upsert({
                        chofer_id: choferData.id, fecha: fechaViaje, dominio: body.dominio !== undefined ? body.dominio : (viajeExistente?.dominio || null),
                        km: body.km !== undefined ? body.km : (viajeExistente?.km || 0), liviano: body.liviano !== undefined ? body.liviano : (viajeExistente?.liviano || 0),
                        euro: body.euro !== undefined ? body.euro : (viajeExistente?.euro || 0), campo: body.campo !== undefined ? body.campo : (viajeExistente?.campo || 0),
                        infinia_d: body.infinia_d !== undefined ? body.infinia_d : (viajeExistente?.infinia_d || 0), hoja_ruta: body.hoja_ruta !== undefined ? body.hoja_ruta : (viajeExistente?.hoja_ruta || []),
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
                        let fechaDia = current.toISOString().split('T')[0]; let estadoDia = Array.isArray(estPayload) ? (estPayload[dayIndex] || '') : estPayload;
                        let infoHoja = obtenerInfoHojaDesdeIso(fechaDia); mesesAfectados.add(infoHoja);

                        if (estadoDia === 'BORRAR' || estadoDia === '' || estadoDia === null || estadoDia === '-') {
                            await supabase.from('diagramas_diarios').delete().match({ chofer_id: choferData.id, fecha: fechaDia });
                            if (idxChoferRAM !== -1 && cacheDatosGlobales.diagramas.diagramas[idxChoferRAM]._diasIso) delete cacheDatosGlobales.diagramas.diagramas[idxChoferRAM]._diasIso[fechaDia];
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

        if (body && body.action !== 'login' && huboCambios) {
            cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
            io.emit('datos_actualizados', cacheDatosGlobales); 
        }
        res.json({ success: true, message: "Guardado en SQL y RAM actualizada." });

    } catch (error) { console.error(error); res.status(500).json({ success: false, error: "Fallo general en Proxy" }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Node Activo en puerto ${PORT}`));
