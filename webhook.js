const express = require('express');

module.exports = function(cacheDatosGlobales, io) {
    const router = express.Router();

    router.post('/google', (req, res) => {
        try {
            const body = req.body;
            const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

            // ==============================================================
            // 1. WEBHOOK: KILÓMETROS
            // ==============================================================
            if (body && body.action === 'webhook_update_viaje') {
                const { chofer, fecha, datos } = body;
                if (chofer && fecha && cacheDatosGlobales.diagramas) {
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes) cacheDatosGlobales.diagramas.nuevaSeccionViajes = {};
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer] = {};
                    
                    cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer][fecha] = {
                        ...(cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer][fecha] || {}),
                        ...datos
                    };
                    io.emit('datos_actualizados', cacheDatosGlobales);
                }
                return res.status(200).json({ success: true, message: "Viaje inyectado" });
            }

            // ==============================================================
            // 2. WEBHOOK: LOTE DE ESTADOS (Ideal para Multi-Delete en Excel)
            // ==============================================================
            if (body && body.action === 'webhook_update_estado_batch') {
                const updates = body.updates || [];
                
                if(updates.length > 0 && cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.diagramas) {
                    updates.forEach(upd => {
                        const { chofer, fechaIso, estado, sheetTab } = upd;
                        const nBuscado = normalizar(chofer);
                        const choferObj = cacheDatosGlobales.diagramas.diagramas.find(c => normalizar(c.nom) === nBuscado);
                        
                        if (choferObj) {
                            const estadoLimpio = estado === "" ? "" : estado; // 👈 Si viene vacío, lo dejamos vacío

                            if (!choferObj._diasIso) choferObj._diasIso = {};
                            choferObj._diasIso[fechaIso] = estadoLimpio;

                            if (sheetTab && choferObj.dias && choferObj.dias[sheetTab]) {
                                let tiraDias = choferObj.dias[sheetTab].split(',');
                                let diaNum = parseInt(fechaIso.split('-')[2], 10);
                                
                                if (diaNum >= 1 && diaNum <= 31) {
                                    tiraDias[diaNum - 1] = estadoLimpio;
                                    choferObj.dias[sheetTab] = tiraDias.join(',');
                                }
                            }
                        }
                    });
                    console.log(`⚡ [Webhook] Se sincronizaron ${updates.length} celdas en RAM.`);
                    io.emit('datos_actualizados', cacheDatosGlobales);
                }
                return res.status(200).json({ success: true, message: "Batch de estados inyectado en RAM" });
            }

            return res.status(200).json({ success: true, message: "Ping ignorado" });

        } catch (error) {
            console.error("❌ Error crítico en Webhook:", error);
            return res.status(500).json({ success: false, error: "Error procesando el webhook" });
        }
    });

    return router;
};
