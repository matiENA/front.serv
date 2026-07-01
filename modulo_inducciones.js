// =======================================================
// 🌱 MÓDULO AISLADO: VISTA EN CASCADA DE INDUCCIONES
// =======================================================

window.renderizarVistaInducciones = function(container) {
    if (!window.datosGlobales || window.datosGlobales.length === 0) {
        container.innerHTML = '<div class="p-10 text-center text-gray-500 font-bold">No hay datos cargados en el sistema.</div>';
        return;
    }

    // 1. Escanear el calendario buscando el estado 'IND' (Inducción)
    let agrupacionesIND = {};
    let hoyFiltro = new Date(window.fechaGlobalContexto + "T12:00:00");
    hoyFiltro.setHours(0, 0, 0, 0);

    window.datosGlobales.forEach(chofer => {
        if (!chofer._diasIso) return;
        
        for (let isoDate in chofer._diasIso) {
            let estadoRaw = String(chofer._diasIso[isoDate] || '').toUpperCase().trim();
            
            // Detectamos si el día tiene la marca de Inducción
            if (estadoRaw === 'IND' || estadoRaw.includes('IND')) {
                // Filtramos opcionalmente para que muestre desde hace 5 días en adelante (no todo el año pasado)
                let dEval = new Date(isoDate + "T12:00:00");
                let limitePasado = new Date(hoyFiltro);
                limitePasado.setDate(limitePasado.getDate() - 5);

                if (dEval >= limitePasado) {
                    if (!agrupacionesIND[isoDate]) agrupacionesIND[isoDate] = [];
                    // Evitar duplicados si hay cruces raros de fechas
                    if (!agrupacionesIND[isoDate].some(c => c._safeId === chofer._safeId)) {
                        agrupacionesIND[isoDate].push(chofer);
                    }
                }
            }
        }
    });

    // 2. Ordenar las fechas cronológicamente
    let fechasOrdenadas = Object.keys(agrupacionesIND).sort((a, b) => new Date(a) - new Date(b));

    // 3. Renderizar el HTML
    let html = `
    <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden mb-8 animate-[fadeIn_0.3s_ease-out]">
        <div class="bg-gradient-to-r from-teal-800 to-teal-600 p-5 flex justify-between items-center text-white">
            <div>
                <h2 class="text-xl font-black flex items-center gap-2">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>
                    Cascada de Inducciones
                </h2>
                <p class="text-xs text-teal-100 mt-1">Choferes programados con estado (IND) en el Diagrama</p>
            </div>
        </div>
        <div class="p-4 sm:p-6 bg-slate-50/50 min-h-[400px]">
    `;

    if (fechasOrdenadas.length === 0) {
        html += `
        <div class="flex flex-col items-center justify-center p-12 opacity-60">
            <span class="text-4xl mb-3">📭</span>
            <p class="text-gray-500 font-bold tracking-wider uppercase text-sm">No hay inducciones programadas</p>
        </div>`;
    } else {
        const opcionesFecha = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };

        fechasOrdenadas.forEach(isoDate => {
            let dObj = new Date(isoDate + "T12:00:00");
            let fechaAmigable = dObj.toLocaleDateString('es-AR', opcionesFecha);
            // Poner primera letra en mayúscula
            fechaAmigable = fechaAmigable.charAt(0).toUpperCase() + fechaAmigable.slice(1);

            // Resaltar si es HOY
            let esHoy = isoDate === window.fechaGlobalContexto;
            let badgeStyle = esHoy 
                ? 'bg-teal-500 text-white border-teal-600 shadow-md animate-pulse' 
                : 'bg-teal-100 text-teal-800 border-teal-200 shadow-sm';

            html += `
            <div class="mb-6 relative">
                <div class="absolute left-[23px] top-8 bottom-[-24px] w-0.5 bg-teal-100 rounded-full"></div>
                
                <div class="flex items-center gap-3 mb-3 relative z-10">
                    <div class="${badgeStyle} font-black px-3 py-1.5 rounded-lg border text-xs tracking-wide flex items-center gap-2">
                        📅 ${fechaAmigable} ${esHoy ? '(HOY)' : ''}
                    </div>
                    <div class="h-px bg-teal-200/50 flex-1"></div>
                </div>
                
                <div class="pl-12 flex flex-col gap-2 relative z-10 mt-1">
            `;
            
            agrupacionesIND[isoDate].forEach(c => {
                html += `
                    <div onclick="cambiarVistaPrincipal('individual'); window.mostrarDetalleConductor('${c._safeId}')" 
                         class="group bg-white p-3 rounded-xl border border-gray-100 shadow-sm hover:shadow-md hover:border-teal-300 cursor-pointer transition-all flex justify-between items-center relative overflow-hidden w-full max-w-2xl">
                        
                        <div class="absolute left-0 top-0 bottom-0 w-1.5 bg-teal-400 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        
                        <div class="flex items-center gap-3 w-full">
                            <div class="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 text-slate-500 flex items-center justify-center font-bold text-xs shrink-0 shadow-inner">
                                ${c.nom.charAt(0)}
                            </div>
                            <div class="flex flex-col min-w-0">
                                <span class="font-bold text-gray-800 text-sm truncate group-hover:text-teal-700 transition-colors">${c.nom}</span>
                                <span class="text-[9px] font-black text-gray-400 uppercase tracking-widest">${c.srv || 'Sin Servicio'} ${c.n_ute ? '• UTE: '+c.n_ute : ''}</span>
                            </div>
                        </div>
                        
                        <div class="shrink-0 pl-3">
                            <span class="px-2 py-1 bg-gray-50 text-gray-400 border border-gray-200 rounded text-[9px] font-bold flex items-center gap-1 group-hover:bg-teal-50 group-hover:text-teal-600 group-hover:border-teal-200 transition-colors">
                                Ver Ficha <svg class="w-3 h-3 transform group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                            </span>
                        </div>
                    </div>
                `;
            });

            html += `</div></div>`;
        });
    }

    html += `</div></div>`;
    container.innerHTML = html;
};