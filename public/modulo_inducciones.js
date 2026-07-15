// =======================================================
// 🌱 MÓDULO AISLADO: VISTA EN CASCADA DE INDUCCIONES (NUEVOS INGRESOS)
// =======================================================

window.renderizarVistaInducciones = function(container) {
    if (typeof datosGlobales === 'undefined' || datosGlobales.length === 0) {
        container.innerHTML = '<div class="p-10 text-center text-gray-500 font-bold">No hay datos cargados en el sistema.</div>';
        return;
    }

    // 1. Escanear a cada chofer UNA SOLA VEZ (Evitar repetidos)
    let agrupacionesPorFecha = {};
    
    datosGlobales.forEach(chofer => {
        if (!chofer._diasIso) return;
        
        let fechasInd = [];
        for (let isoDate in chofer._diasIso) {
            let estadoRaw = String(chofer._diasIso[isoDate] || '').toUpperCase().trim();
            // Detectamos si el día tiene la marca de Inducción
            if (estadoRaw === 'IND' || estadoRaw.includes('IND')) {
                fechasInd.push(isoDate);
            }
        }

        // Si tiene inducciones, tomamos solo su registro más reciente (no se repite el nombre)
        if (fechasInd.length > 0) {
            // Ordenamos sus fechas de inducción de la más nueva a la más vieja
            fechasInd.sort((a, b) => new Date(b) - new Date(a));
            let fechaMasReciente = fechasInd[0]; 

            if (!agrupacionesPorFecha[fechaMasReciente]) agrupacionesPorFecha[fechaMasReciente] = [];
            agrupacionesPorFecha[fechaMasReciente].push(chofer);
        }
    });

    // 2. CASCADA AL REVÉS: Ordenamos todas las fechas de mayor a menor (Más recientes arriba)
    let fechasOrdenadas = Object.keys(agrupacionesPorFecha).sort((a, b) => new Date(b) - new Date(a));

    // 3. AGRUPACIÓN POR MESES
    let agrupacionPorMes = {};
    const nombresMeses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

    fechasOrdenadas.forEach(isoDate => {
        let dObj = new Date(isoDate + "T12:00:00");
        // Creamos la etiqueta del mes (Ej: "JUNIO 2026")
        let mesKey = `${nombresMeses[dObj.getMonth()].toUpperCase()} ${dObj.getFullYear()}`;
        
        if (!agrupacionPorMes[mesKey]) agrupacionPorMes[mesKey] = [];
        agrupacionPorMes[mesKey].push(isoDate);
    });

    // 4. RENDERIZADO VISUAL
    let countIngresos = 0;
    fechasOrdenadas.forEach(f => countIngresos += agrupacionesPorFecha[f].length);

    let html = `
    <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden mb-8 animate-[fadeIn_0.3s_ease-out]">
        <div class="bg-gradient-to-r from-teal-800 to-teal-600 p-5 flex justify-between items-center text-white">
            <div>
                <h2 class="text-xl font-black flex items-center gap-2">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>
                    Nuevos Ingresos (Inducciones)
                </h2>
                <p class="text-xs text-teal-100 mt-1">Personal en inducción agrupado por mes de ingreso</p>
            </div>
            <span class="px-3 py-1 bg-white/20 rounded-lg text-sm font-black border border-white/30 backdrop-blur-sm">${countIngresos} Ingresos Históricos</span>
        </div>
        <div class="p-4 sm:p-6 bg-slate-50/50 min-h-[400px]">
    `;

    if (fechasOrdenadas.length === 0) {
        html += `
        <div class="flex flex-col items-center justify-center p-12 opacity-60">
            <span class="text-4xl mb-3">📭</span>
            <p class="text-gray-500 font-bold tracking-wider uppercase text-sm">No hay ingresos registrados en el diagrama</p>
        </div>`;
    } else {
        const opcionesFecha = { weekday: 'long', day: 'numeric', month: 'long' };

        // Iteramos sobre los meses (que ya están ordenados porque vienen de fechasOrdenadas)
        for (let mes in agrupacionPorMes) {
            html += `
            <div class="mb-8 relative bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
                <div class="absolute -top-3.5 left-4 bg-teal-600 text-white px-4 py-1 rounded-lg text-xs font-black tracking-widest shadow-md">
                    ${mes}
                </div>
                <div class="mt-4 flex flex-col gap-6">
            `;

            agrupacionPorMes[mes].forEach(isoDate => {
                let dObj = new Date(isoDate + "T12:00:00");
                let fechaAmigable = dObj.toLocaleDateString('es-AR', opcionesFecha);
                fechaAmigable = fechaAmigable.charAt(0).toUpperCase() + fechaAmigable.slice(1);

                let esHoy = isoDate === fechaGlobalContexto;
                let badgeStyle = esHoy 
                    ? 'bg-teal-100 text-teal-800 border-teal-300 font-black animate-pulse' 
                    : 'bg-gray-100 text-gray-600 border-gray-200 font-bold';

                html += `
                <div class="relative">
                    <div class="absolute left-[15px] top-8 bottom-[-16px] w-px bg-gray-200 rounded-full hidden sm:block"></div>
                    
                    <div class="flex items-center gap-3 mb-3 relative z-10">
                        <div class="${badgeStyle} px-3 py-1.5 rounded-md border text-xs flex items-center gap-1.5 shadow-sm">
                            📅 ${fechaAmigable} ${esHoy ? '<span class="text-[9px] bg-teal-500 text-white px-1.5 rounded ml-1">HOY</span>' : ''}
                        </div>
                        <div class="h-px bg-gray-200 flex-1"></div>
                    </div>
                    
                    <div class="pl-0 sm:pl-8 flex flex-col gap-2 relative z-10">
                `;
                
                agrupacionesPorFecha[isoDate].forEach(c => {
                    html += `
                        <div onclick="cambiarVistaPrincipal('individual'); window.mostrarDetalleConductor('${c._safeId}')" 
                            class="group bg-white p-2.5 sm:p-3 rounded-xl border border-gray-100 shadow-sm hover:shadow-md hover:border-teal-400 cursor-pointer transition-all flex justify-between items-center relative overflow-hidden w-full max-w-3xl">
                            
                            <div class="absolute left-0 top-0 bottom-0 w-1 bg-teal-400 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                            
                            <div class="flex items-center gap-3 w-full pl-1">
                                <div class="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 text-slate-500 flex items-center justify-center font-bold text-xs shrink-0 shadow-inner">
                                    ${c.nom.charAt(0)}
                                </div>
                                <div class="flex flex-col min-w-0">
                                    <span class="font-bold text-gray-800 text-sm truncate group-hover:text-teal-700 transition-colors">${c.nom}</span>
                                    <span class="text-[9px] font-black text-gray-400 uppercase tracking-widest">${c.srv || 'Sin Servicio'} ${c.n_ute ? '• UTE: '+c.n_ute : ''}</span>
                                </div>
                            </div>
                            
                            <div class="shrink-0 pl-3 pr-1">
                                <span class="w-7 h-7 bg-gray-50 text-gray-400 border border-gray-200 rounded-lg flex items-center justify-center group-hover:bg-teal-50 group-hover:text-teal-700 group-hover:border-teal-200 transition-colors shadow-sm">
                                    <svg class="w-4 h-4 transform group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                                </span>
                            </div>
                        </div>
                    `;
                });

                html += `</div></div>`;
            });

            html += `</div></div>`; 
        }
    }

    html += `</div></div>`;
    container.innerHTML = html;
};
