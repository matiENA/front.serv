// ==========================================
// 🚛 MÓDULO CONTROL DE FLOTA (LÓGICA)
// ==========================================

// 1. Declaración de la variable de estado (fuera de las funciones)
let filtroFlotaActual = 'todos';

// 2. Tu función (perfectamente escrita)
window.setFiltroFlota = function(tipoFiltro) {
    filtroFlotaActual = tipoFiltro;
    
    const botones = ['todos', 'vencer', 'vencido'];
    botones.forEach(b => {
        let btn = document.getElementById(`btn-flota-${b}`);
        if(btn) {
            btn.classList.remove('bg-white', 'shadow-sm', 'text-gray-800');
            btn.classList.add('text-gray-500');
        }
    });

    let btnActivo = document.getElementById(`btn-flota-${tipoFiltro === 'por_vencer' ? 'vencer' : tipoFiltro}`);
    if(btnActivo) {
        btnActivo.classList.remove('text-gray-500');
        btnActivo.classList.add('bg-white', 'shadow-sm', 'text-gray-800');
    }

    // Asegúrate de que esta función también exista globalmente
    if (typeof window.renderizarFlota === 'function') {
        window.renderizarFlota();
    }
};


window.renderizarFlota = function() {
    const tbody = document.getElementById('tbody-flota');
    if (!tbody) return; // Por seguridad, si la tabla no está en el DOM, no hace nada

    tbody.innerHTML = ''; 

    // Fechas para la evaluación
    const hoy = new Date();
    hoy.setHours(0,0,0,0);
    const limitePorVencer = new Date();
    limitePorVencer.setDate(hoy.getDate() + 30); 

    let itemsFlota = []; 
    
    // ... Tu lógica de extracción de datosGlobales hacia itemsFlota ...

    if (itemsFlota.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-gray-400 font-bold">No hay datos de flota para analizar.</td></tr>`;
        return;
    }

    let html = '';

    itemsFlota.forEach(item => {
        if (!item.fechaStr) return; 

        const fechaVto = new Date(item.fechaStr);
        fechaVto.setHours(0,0,0,0); 

        let estado = 'ok';
        let claseEstado = 'bg-green-100 text-green-700';
        let textoEstado = 'Al día';

        if (fechaVto < hoy) {
            estado = 'vencido';
            claseEstado = 'bg-red-100 text-red-700';
            textoEstado = 'VENCIDO';
        } else if (fechaVto <= limitePorVencer) {
            estado = 'por_vencer';
            claseEstado = 'bg-yellow-100 text-yellow-800';
            textoEstado = 'POR VENCER';
        }

        // Filtro
        if (filtroFlotaActual === 'vencido' && estado !== 'vencido') return;
        if (filtroFlotaActual === 'por_vencer' && estado !== 'por_vencer') return;

        html += `
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                <td class="p-3 pl-4 font-bold text-gray-900 dark:text-white uppercase">${item.nombre}</td>
                <td class="p-3 font-medium">${item.doc}</td>
                <td class="p-3 font-bold">${item.fechaStr}</td>
                <td class="p-3">
                    <span class="px-2.5 py-1 rounded-lg text-[10px] font-black tracking-widest uppercase ${claseEstado}">
                        ${textoEstado}
                    </span>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html === '' 
        ? `<tr><td colspan="4" class="p-6 text-center text-gray-400 font-bold">No se encontraron registros.</td></tr>` 
        : html;
};
