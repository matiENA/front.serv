const express = require('express');
const compression = require('compression');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(compression()); 

// 👉 CORS Blindado 
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.options('*', cors());

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

const ID_SPREADSHEET_MASTER = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const ID_SPREADSHEET_DIAGRAMAS = '1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU';
const ID_SHEET_OBSERVACIONES = '1VwCNK89ecaac7IDlMWWCLHRqZoch9HB6vop5AfQEaA0';
const ID_SHEET_APTOS_MEDICOS = '1oJmN8hurfHfNnGBYUFcBdlrIj2VUzeIyq0ZTWxTpYNI';
const ID_SHEET_MOVIMIENTOS = '1hhJKwp9xOOHL_zZSJMbrJh5fwfsIPre155UTWhKWI44'; 
const ID_SHEET_KILOMETROS = '1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM'; // 👉 NUEVO: Archivo de KM
const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

// ==========================================
// 🛡️ LECTOR ULTRALIVIANO CON ANTI-BLOQUEO (REINTENTOS AUTOMÁTICOS)
// ==========================================
async function fetchRango(spreadsheetId, rango, reintentos = 3) {
    for (let i = 0; i < reintentos; i++) {
        try {
            const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rango)}`;
            const res = await serviceAccountAuth.request({ url });
            return res.data.values || [];
        } catch (e) {
            if (e.response && e.response.status === 429) {
                // Si Google pide calmarse, esperamos 1.5s, 3s, o 4.5s según el intento, y repetimos
                console.warn(`⏳ Límite de Google alcanzado en ${rango}. Reintentando silenciosamente en ${(i + 1) * 1.5}s...`);
                await new Promise(resolve => setTimeout(resolve, (i + 1) * 1500));
            } else {
                console.warn(`⚠️ Error leyendo rango ${rango}:`, e.response?.statusText || e.message);
                return []; // Si el error es otro (ej. hoja no existe), devolvemos vacío y cortamos
            }
        }
    }
    return []; // Si falló los 3 intentos, abortamos para no colgar el sistema
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

setTimeout(() => { 
    console.log("⏳ [Boot] Disparando evento inicial...");
    flujoEncoladoGlobal(true); 
}, 3000); 

// ==========================================
// 🧠 2. EL CEREBRO: CONSTRUCCIÓN NATIVA (CERO DEPENDENCIA DE SUPABASE)
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

        let listaChoferesMaestros = [];
        try {
            const rowsH1 = await fetchRango(ID_SPREADSHEET_MASTER, "'choferes y unidades'!H1");
            if (rowsH1 && rowsH1.length > 0 && rowsH1[0][0]) {
                let jsonRaw = String(rowsH1[0][0]).trim();
                let parsedChoferes = JSON.parse(jsonRaw);
                parsedChoferes.forEach(c => {
                    if(!c.nombre) return;
                    let nombreReal = String(c.nombre).trim();
                    let norm = normalizar(nombreReal);
                    resDiagGAS.flota[norm] = { tractor: c.tractor || '', semi: c.semi || '', servicio: c.servicio || '', n_ute: c.n_ute || '', td: c.td || '-', hex1: c.hex1 || '', hex2: c.hex2 || '' };
                    if (!listaChoferesMaestros.some(x => x.norm === norm)) { listaChoferesMaestros.push({ nombre: nombreReal, norm: norm }); }
                });
            }
        } catch(e) { console.error("❌ Error parseando el JSON de H1:", e); }

        try {
            const rowsAptos = await fetchRango(ID_SHEET_APTOS_MEDICOS, "'Seguimiento Avalados Mensual'!A1:AT350");
            resDiagGAS.aptosMedicos = {};
            
            if (rowsAptos.length > 0) {
                const headers = rowsAptos[0]; 
                const hoy = new Date();
                const d = String(hoy.getDate()).padStart(2, '0');
                const m = String(hoy.getMonth() + 1).padStart(2, '0');
                const y = hoy.getFullYear();
                const mesesLargo = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
                
                const formatosHoy = [`${hoy.getDate()}/${mesesLargo[hoy.getMonth()]}/${y}`.toLowerCase(), `${d}/${m}/${y}`, `${d}/${m}`, String(hoy.getDate())];

                let colDiaria = -1;
                for (let c = 12; c < headers.length; c++) {
                    let headLimpio = String(headers[c] || "").trim().toLowerCase();
                    if (formatosHoy.includes(headLimpio)) { colDiaria = c; break; }
                }
                if (colDiaria === -1) {
                    for (let c = headers.length - 1; c >= 12; c--) { if (String(headers[c] || "").trim() !== "") { colDiaria = c; break; } }
                }

                for (let i = 1; i < rowsAptos.length; i++) {
                    let fila = rowsAptos[i];
                    let nombreRaw = String(fila[0] || "").trim(); 
                    if (!nombreRaw || nombreRaw.toLowerCase() === "nombre completo") continue;

                    let cuil = String(fila[1] || "").trim();
                    let dniLimpio = String(cuil).replace(/\D/g, '');
                    if (dniLimpio.length === 11) dniLimpio = String(parseInt(dniLimpio.substring(2, 10), 10));
                    else if (dniLimpio.length === 10) dniLimpio = String(parseInt(dniLimpio.substring(2, 9), 10));
                    else dniLimpio = String(parseInt(dniLimpio, 10) || "");

                    let responsable = String(fila[5] || "").trim();
                    let observaciones = String(fila[10] || "").trim();
                    let observaciones_salud = String(fila[11] || "").trim();

                    let estadoDiario = "-";
                    let limiteBusqueda = colDiaria > -1 ? colDiaria : fila.length - 1;
                    for (let c = limiteBusqueda; c >= 12; c--) {
                        let val = String(fila[c] || "").trim();
                        if (val !== "" && val !== "-") { estadoDiario = val; break; }
                    }

                    let nombreNormalizado = nombreRaw.replace(/,/g, '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
                    let objApto = { dni: dniLimpio, cuil: cuil, estado: estadoDiario, responsable: responsable, observaciones: observaciones, observaciones_sector_salud: observaciones_salud };

                    if (dniLimpio) resDiagGAS.aptosMedicos[dniLimpio] = objApto;
                    if (nombreNormalizado) resDiagGAS.aptosMedicos[nombreNormalizado] = objApto;
                }
            }
        } catch (e) { console.error("❌ Error leyendo Aptos Médicos:", e); }

        const rowsObs = await fetchRango(ID_SHEET_OBSERVACIONES, "'Movimientos'!A5:H2000");
        resDiagGAS.observaciones = {};
        rowsObs.forEach(row => {
            if(!row[1]) return;
            let norm = normalizar(row[1]);
            if (!resDiagGAS.observaciones[norm]) resDiagGAS.observaciones[norm] = [];
            resDiagGAS.observaciones[norm].push({ admin: row[0] || "-", fecha: row[2] || "-", unidad: row[3] || "-", evento: row[4] || "-", obsEvento: row[5] || "", estado: row[6] || "-", obsEstado: row[7] || "" });
        });

        // Carga de Caché Base
        const rowsCache = await fetchRango(ID_SPREADSHEET_MASTER, "'API_CACHE_BASICO'!A1:Z15");
        const extraer = (idx) => { if (!rowsCache[idx]) return {}; try { return JSON.parse(rowsCache[idx].join('').replace(/^'/, "")); } catch(e) { return {}; } };
        resDiagGAS.documentos = extraer(1); resDiagGAS.habilitaciones = extraer(2); resDiagGAS.dnis = extraer(3); resDiagGAS.certificados = extraer(4); resDiagGAS.telefonos = extraer(5);

        let diasLegacyIso = {}; let dictDiasSQL = {}; let hojasInfo = []; let nuevaSeccionViajes = {};

        if (esArranque) {
            // ==========================================
            // 🪪 RED DE RASTREO MAESTRA DE DNIs 
            // ==========================================
            try {
                const ID_SHEET_HABILITACIONES = '1hPDno09tMBtKh7aIdsvzEYcyOY7leYj2B6XnniD0aXg';
                const ID_SHEET_DOCUMENTOS = '1pnYXKDSv70Vq78Rchxus5FHMKdgXdbfltVsEg6vArjo';
                
                // Pedimos las 3 planillas al mismo tiempo (Paralelismo = Velocidad)
                const [resDniTab, resDocsTab, resHabsTab] = await Promise.all([
                    fetchRango(ID_SPREADSHEET_MASTER, "'dni'!A1:I300"),
                    fetchRango(ID_SHEET_DOCUMENTOS, "'PERIODICOS'!A1:E300"),
                    fetchRango(ID_SHEET_HABILITACIONES, "'VENCIMIENTOS'!A1:C300")
                ]);

                let dnisMap = resDiagGAS.dnis || {};

                const extraerDni = (cuil) => {
                    let l = String(cuil).replace(/\D/g, '');
                    if (!l) return "";
                    if (l.length === 11) return String(parseInt(l.substring(2, 10), 10));
                    if (l.length === 10) return String(parseInt(l.substring(2, 9), 10));
                    return String(parseInt(l, 10));
                };

                // 1. Rastrear en pestaña 'dni' del Excel Maestro
                resDniTab.forEach(fila => {
                    let nIzq = normalizar(fila[0]); let dIzq = String(fila[2] || '').replace(/\D/g, '');
                    if (nIzq && dIzq) dnisMap[nIzq] = { dni: String(parseInt(dIzq, 10)) };
                    
                    let nDer = normalizar(fila[5]); let dDer = String(fila[7] || '').replace(/\D/g, '');
                    if (nDer && dDer) dnisMap[nDer] = { dni: String(parseInt(dDer, 10)) };
                });

                // 2. Rastrear en Excel de Documentos (Tab PERIODICOS)
                resDocsTab.forEach(fila => {
                    let nom = normalizar(fila[1]); let cuil = fila[4]; let dni = extraerDni(cuil);
                    if (nom && dni && !dnisMap[nom]) dnisMap[nom] = { dni: dni };
                });

                // 3. Rastrear en Excel de Habilitaciones (Tab VENCIMIENTOS)
                resHabsTab.forEach(fila => {
                    let nom = normalizar(fila[1]); let dni = String(fila[2] || '').replace(/\D/g, '');
                    if (nom && dni && !dnisMap[nom]) dnisMap[nom] = { dni: String(parseInt(dni, 10)) };
                });

                resDiagGAS.dnis = dnisMap;
                console.log("🪪 Red de DNIs extraída y cruzada exitosamente (Docs, Vencs y Maestro).");
            } catch (e) { console.error("❌ Error rastreando DNIs en planillas anexas:", e); }

            // ==========================================

            const rowsVenc = await fetchRango(ID_SHEET_MOVIMIENTOS, "'Vencimientos.'!A2:N300");
            resDiagGAS.vencimientosObj = rowsVenc.map(row => {
                if (!row[1]) return null;
                return { col_b: row[1] || "", col_c: row[2] || "", col_g: row[6] || "", col_h: row[7] || "", col_j: row[9] || "", col_k: row[10] || "", col_l: row[11] || "", col_m: row[12] || "", col_n: row[13] || "" };
            }).filter(Boolean);

            const rowsFotos = await fetchRango(ID_SPREADSHEET_MASTER, "'fotos'!A1:B200");
            resDiagGAS.fotosImgur = {};
            rowsFotos.forEach(row => { if (row[0] && row[1] && row[1].includes('http')) resDiagGAS.fotosImgur[row[0].replace(/\D/g, '')] = row[1].trim(); });

            let hoy = new Date(); let offsetsMeses = [-1, 0, 1, 2, 3]; 
            for (let i of offsetsMeses) {
                let d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1); let anio = d.getFullYear(); let mesStr = String(d.getMonth() + 1).padStart(2, '0');
                let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2);
                hojasInfo.push({ nombre: nombreHoja, anio, mesStr });
                
                const rowsDiag = await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHoja}'!A6:AL255`);
                rowsDiag.forEach(row => {
                    let cellNombre = row[1];
                    if (!cellNombre || cellNombre === "APELLIDO Y NOMBRE" || cellNombre === "Personal Activo") return;
                    let nomNorm = normalizar(cellNombre); if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};
                    for (let dia = 1; dia <= 31; dia++) {
                        let estado = row[dia + 3];
                        if (estado && estado !== '-') { let isoDate = `${anio}-${mesStr}-${String(dia).padStart(2, '0')}`; diasLegacyIso[nomNorm][isoDate] = String(estado).toUpperCase().trim(); } 
                    }
                });
            }

            try {
                const rowsKm = await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A2:T");
                const limiteDate = new Date();
                limiteDate.setDate(limiteDate.getDate() - 180); 
                const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;

                rowsKm.forEach(row => {
                    let fechaRaw = row[1]; let nombreRaw = row[2];
                    if (!fechaRaw || !nombreRaw) return;

                    let dObj; let parts = String(fechaRaw).split(' ')[0].split(/[\/\-]/);
                    if (parts.length >= 3) {
                        let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2];
                        dObj = new Date(aa, parseInt(parts[1], 10) - 1, parts[0]);
                    } else { dObj = new Date(fechaRaw); }
                    if (isNaN(dObj.getTime()) || dObj < limiteDate) return;

                    let choferNorm = normalizar(nombreRaw); let isoDate = dObj.toISOString().split('T')[0];
                    let kmBase = parseNum(row[16]); let kmBackup = parseNum(row[8]); let km = kmBase > 0 ? kmBase : kmBackup;
                    let liviano = parseNum(row[3]); let euro = parseNum(row[4]); let campo = parseNum(row[5]); let infiniaD = parseNum(row[7]);
                    let hojaStr = String(row[19] || "").trim();

                    if (km > 0 || campo > 0 || liviano > 0 || euro > 0 || infiniaD > 0 || hojaStr !== "") {
                        if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                        if (!nuevaSeccionViajes[choferNorm][isoDate]) nuevaSeccionViajes[choferNorm][isoDate] = { dominio: String(row[0] || '').trim(), km: 0, liviano: 0, euro: 0, campo: 0, infiniaD: 0, hoja_ruta: [] };
                        let target = nuevaSeccionViajes[choferNorm][isoDate];
                        target.km += km; target.liviano += liviano; target.euro += euro; target.campo += campo; target.infiniaD += infiniaD;
                        if (hojaStr !== "") {
                            let arrHojas = hojaStr.split(',').map(s => s.trim()).filter(Boolean);
                            arrHojas.forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });
                        }
                    }
                });
                console.log("🚚 KMs y Hojas de Ruta extraídas exitosamente desde Google Sheets");
            } catch(e) { console.error("Error leyendo KMs:", e); }

            // Lógica final de Ensamblaje...
            let diagramasHibridos = []; 
            listaChoferesMaestros.forEach(choferMaster => {
                let nomNorm = choferMaster.norm; let nombreReal = choferMaster.nombre;
                let flota = resDiagGAS.flota[nomNorm] || {}; let mergeIso = { ...(diasLegacyIso[nomNorm] || {}), ...(dictDiasSQL[nomNorm] || {}) };
                let diasFront = {};
                
                hojasInfo.forEach(info => {
                    let tira = [];
                    for (let dia = 1; dia <= 31; dia++) { tira.push(mergeIso[`${info.anio}-${info.mesStr}-${String(dia).padStart(2, '0')}`] || "-"); }
                    diasFront[info.nombre] = tira.join(",");
                });

                diagramasHibridos.push({
                    _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"), nom: nombreReal, 
                    tractor: flota.tractor || '', semi: flota.semi || '', srv: flota.servicio || '', n_ute: flota.n_ute || '', 
                    td: flota.td || '-', hex1: flota.hex1 || '', hex2: flota.hex2 || '', hex_1: "#ffffff", hex_2: "#ffffff", dias: diasFront, _diasIso: mergeIso     
                });
            });

            cacheDatosGlobales.diagramas = { 
                diagramas: diagramasHibridos, nuevaSeccionViajes, documentos: resDiagGAS.documentos, habilitaciones: resDiagGAS.habilitaciones, certificados: resDiagGAS.certificados,
                dnis: resDiagGAS.dnis, telefonos: resDiagGAS.telefonos, observaciones: resDiagGAS.observaciones, aptosMedicos: resDiagGAS.aptosMedicos, 
                vencimientosObj: resDiagGAS.vencimientosObj, fotosImgur: resDiagGAS.fotosImgur
            };

        } else {
            if (cacheDatosGlobales.diagramas) {
                cacheDatosGlobales.diagramas.observaciones = resDiagGAS.observaciones;
                cacheDatosGlobales.diagramas.aptosMedicos = resDiagGAS.aptosMedicos;
            }
        }

        cacheDatosGlobales.tds = { campo:{}, infinia:{}, liviano:{}, euro:{}, estados:{}, codigosExtra:{} };
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        io.emit('datos_actualizados', cacheDatosGlobales);
        console.log(`✅ RAM Ensamblada Completa.`);
    } catch (error) { console.error("❌ Error en construcción de RAM:", error); }
}

// ==========================================
// 🔔 3. RECEPTORES DE WEBHOOKS (CON AMORTIGUADOR)
// ==========================================
let temporizadorWebhook = null;

app.post('/api/webhook/google', async (req, res) => { 
    // Respondemos 'OK' a Google al instante para que no se quede colgado
    res.json({ success: true }); 
    
    // Si llegan muchos webhooks seguidos, cancelamos la actualización anterior...
    if (temporizadorWebhook) clearTimeout(temporizadorWebhook);
    
    // ...y programamos una sola actualización para dentro de 6 segundos
    temporizadorWebhook = setTimeout(() => {
        console.log("📥 Agrupación de webhooks completada. Ejecutando actualización...");
        flujoEncoladoGlobal(false); 
    }, 6000); 
});

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
                huboCambios = true;
            }
        }

// ==========================================
        // 🚀 GUARDADO DE DOCUMENTOS Y VENCIMIENTOS
        // ==========================================
        if (body && body.action === 'guardarDocumentos') {
            let nBuscado = normalizar(body.nombre);

            // 🎚️ SWITCH: Guardar en Supabase (Encender/Apagar)
            const GUARDAR_EN_SUPABASE = false; // <-- Cambia a 'true' si algún día quieres reactivarlo

            // --- 1. GUARDADO OPCIONAL EN SUPABASE ---
            if (GUARDAR_EN_SUPABASE) {
                try {
                    const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', body.nombre).single();
                    if (choferData) {
                        await supabase.from('documentos_choferes').upsert({ chofer_id: choferData.id, venc_periodico: body.exVen, venc_licencia: body.licVen, venc_cert_mp: body.certVen }, { onConflict: 'chofer_id' });
                    }
                } catch(e) { console.error("Error guardando doc en Supabase:", e); }
            }

            // --- 2. GUARDADO DIRECTO EN GOOGLE SHEETS VISUALES ---
            // Extraer DNI de la RAM (Usando la ruta correcta: diagramas.dnis)
            let dniBuscado = cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.dnis && cacheDatosGlobales.diagramas.dnis[nBuscado] ? cacheDatosGlobales.diagramas.dnis[nBuscado].dni : "";

            // A. GUARDAR HABILITACIONES Y CERTIFICADO (Archivo 1hPDno...)
            if (body.licVen || body.certVen) {
                try {
                    const ID_SHEET_HABILITACIONES = '1hPDno09tMBtKh7aIdsvzEYcyOY7leYj2B6XnniD0aXg';
                    // Pedimos desde la A para alinear el índice de array con el número de fila exacto
                    const resHab = await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!A:C` });
                    const rowsHab = resHab.data.values || [];
                    let rowIndexHab = -1;
                    
                    for (let i = 0; i < rowsHab.length; i++) {
                        let nSheet = normalizar(rowsHab[i][1]); // Columna B
                        let dniSheet = String(rowsHab[i][2] || "").replace(/\D/g, ''); // Columna C
                        if ((dniBuscado && dniSheet === dniBuscado) || nSheet === nBuscado) {
                            rowIndexHab = i + 1; 
                            break;
                        }
                    }
                    
                    if (rowIndexHab !== -1) {
                        let reqs = [];
                        if (body.licVen) {
                            let p = body.licVen.split('-'); let fechaArg = `${p[2]}/${p[1]}/${p[0]}`; // Convertir a DD/MM/YYYY
                            reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!E${rowIndexHab}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[fechaArg]] } }));
                        }
                        if (body.certVen) {
                            let p = body.certVen.split('-'); let fechaArg = `${p[2]}/${p[1]}/${p[0]}`; // Convertir a DD/MM/YYYY
                            reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!D${rowIndexHab}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[fechaArg]] } }));
                        }
                        await Promise.all(reqs); // Guardar ambos en paralelo súper rápido
                    }
                } catch(e) { console.error("Error guardando Habilitaciones:", e); }
            }

            // B. GUARDAR EXAMEN PERIÓDICO (Archivo 1pnYXK...)
            if (body.exVen) {
                try {
                    const ID_SHEET_DOCUMENTOS = '1pnYXKDSv70Vq78Rchxus5FHMKdgXdbfltVsEg6vArjo';
                    const resDoc = await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!A:E` });
                    const rowsDoc = resDoc.data.values || [];
                    let rowIndexDoc = -1;

                    const extraerDni = (cuil) => {
                        let l = String(cuil).replace(/\D/g, '');
                        if (!l) return "";
                        if (l.length === 11) return String(parseInt(l.substring(2, 10), 10));
                        if (l.length === 10) return String(parseInt(l.substring(2, 9), 10));
                        return String(parseInt(l, 10));
                    };

                    for (let i = 0; i < rowsDoc.length; i++) {
                        let nSheet = normalizar(rowsDoc[i][1]); // Columna B
                        let cuilSheet = rowsDoc[i][4]; // Columna E
                        let dniSheet = extraerDni(cuilSheet);

                        if ((dniBuscado && dniSheet === dniBuscado) || nSheet === nBuscado) {
                            rowIndexDoc = i + 1;
                            break;
                        }
                    }

                    if (rowIndexDoc !== -1) {
                        let p = body.exVen.split('-'); let fechaArg = `${p[2]}/${p[1]}/${p[0]}`; // Convertir a DD/MM/YYYY
                        await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!I${rowIndexDoc}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[fechaArg]] } });
                    }
                } catch(e) { console.error("Error guardando Documentos:", e); }
            }

            // --- 3. ACTUALIZACIÓN INSTANTÁNEA EN LA ESTRUCTURA RAM CORRECTA ---
            if (!cacheDatosGlobales.diagramas.documentos) cacheDatosGlobales.diagramas.documentos = {};
            if (!cacheDatosGlobales.diagramas.habilitaciones) cacheDatosGlobales.diagramas.habilitaciones = {};
            if (!cacheDatosGlobales.diagramas.certificados) cacheDatosGlobales.diagramas.certificados = {};

            const calcularEstado = (fechaStr) => {
                if (!fechaStr) return 'OK';
                let partes = fechaStr.split('-');
                let v = new Date(partes[0], partes[1] - 1, partes[2]);
                let diff = Math.ceil((v - new Date()) / 86400000);
                return diff < 0 ? 'VENCIDO' : (diff <= 30 ? 'POR_VENCER' : 'VIGENTE');
            };

            if (body.exVen) cacheDatosGlobales.diagramas.documentos[nBuscado] = { ven: body.exVen, estado: calcularEstado(body.exVen) };
            if (body.licVen) cacheDatosGlobales.diagramas.habilitaciones[nBuscado] = { ven: body.licVen, estado: calcularEstado(body.licVen) };
            if (body.certVen) cacheDatosGlobales.diagramas.certificados[nBuscado] = { ven: body.certVen, estado: calcularEstado(body.certVen) };

            // 💾 PERSISTIR LA RAM EN 'API_CACHE_BASICO' PARA FUTUROS REINICIOS
            const ID_SPREADSHEET_MASTER = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
            const guardarCacheRow = async (fila, dataObj) => {
                let jsonStr = JSON.stringify(dataObj);
                let chunks = [];
                for (let i = 0; i < jsonStr.length; i += 45000) chunks.push("'" + jsonStr.substring(i, i + 45000));
                try {
                    // Primero vaciar fila para evitar basura y luego escribir
                    await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'API_CACHE_BASICO'!A${fila}:Z${fila}:clear`, method: 'POST' });
                    await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'API_CACHE_BASICO'!A${fila}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [chunks] } });
                } catch(e) { console.error(`Error guardando caché fila ${fila}:`, e); }
            };

            // Escribe en paralelo en la BD Maestra las filas 2, 3 y 5
            let promesasCache = [];
            if (body.exVen) promesasCache.push(guardarCacheRow(2, cacheDatosGlobales.diagramas.documentos));
            if (body.licVen) promesasCache.push(guardarCacheRow(3, cacheDatosGlobales.diagramas.habilitaciones));
            if (body.certVen) promesasCache.push(guardarCacheRow(5, cacheDatosGlobales.diagramas.certificados));
            await Promise.all(promesasCache);

            huboCambios = true;
        }

        // 🚀 NUEVO GUARDADO DIRECTO DE HOJA DE RUTA A GOOGLE SHEETS (Adiós Supabase)
        if (body && body.action === 'guardarHojaRutaPlanilla') {
            let stringHojas = (body.hojas || []).join(', ');
            let nBuscado = normalizar(body.nombre);
            let dTarget = new Date(body.fecha + "T12:00:00");
            let targetStr = `${String(dTarget.getDate()).padStart(2,'0')}/${String(dTarget.getMonth()+1).padStart(2,'0')}/${String(dTarget.getFullYear()).slice(-2)}`;
            
            // Leemos solo nombres y fechas para no saturar memoria RAM
            const urlScan = `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!B:C`;
            const resScan = await serviceAccountAuth.request({ url: urlScan });
            const rowsBC = resScan.data.values || [];
            
            let rowIndex = -1;
            for (let i = 1; i < rowsBC.length; i++) {
                let fFila = String(rowsBC[i][0] || '').trim();
                let nFila = normalizar(rowsBC[i][1]);
                if (nFila === nBuscado && (fFila.startsWith(targetStr) || fFila.startsWith(body.fecha) || fFila.includes(targetStr))) {
                    rowIndex = i + 1; // 1-based API 
                    break;
                }
            }

            if (rowIndex !== -1) {
                // Si existe, actualizamos la celda T (col 20) usando PUT directo
                const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!T${rowIndex}?valueInputOption=USER_ENTERED`;
                await serviceAccountAuth.request({ url: updateUrl, method: 'PUT', data: { values: [[stringHojas]] } });
            } else {
                // Si no existe, usamos la librería para anexar una fila al final
                const docKm = new GoogleSpreadsheet(ID_SHEET_KILOMETROS, serviceAccountAuth);
                await docKm.loadInfo();
                const sheetKm = docKm.sheetsByTitle['KM'] || docKm.sheetsByIndex[0];
                let nuevaFila = new Array(20).fill("");
                nuevaFila[0] = body.tractor || ""; nuevaFila[1] = targetStr; nuevaFila[2] = body.nombre; nuevaFila[19] = stringHojas;
                await sheetKm.addRow(nuevaFila);
            }
            huboCambios = true;
        }

        if (body && body.action !== 'login' && huboCambios) { flujoEncoladoGlobal(false); }
        res.json({ success: true, message: "Operación completada" });

    } catch (error) { console.error(error); res.status(500).json({ success: false, error: "Fallo general en Proxy" }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Node Activo en puerto ${PORT}`));
