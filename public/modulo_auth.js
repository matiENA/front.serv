// ==========================================
// 🔐 MÓDULO DE AUTENTICACIÓN AISLADO
// ==========================================

const HTML_LOGIN = `
<div id="login-wall" class="fixed inset-0 z-[200] bg-gray-100 flex flex-col items-center justify-center transition-opacity duration-500">
    <div class="bg-white p-8 rounded-2xl shadow-xl border border-gray-200 w-full max-w-sm transform transition-all animate-[fadeInDown_0.3s_ease-out]">
        
        <div class="text-center mb-8">
            <div class="w-16 h-16 bg-primary text-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
                <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
            </div>
            <h1 class="text-2xl font-black text-gray-900 tracking-tight">Diagramas EOR</h1>
            <p class="text-xs text-gray-500 mt-1 uppercase tracking-widest font-bold">Acceso Restringido</p>
        </div>

        <div class="space-y-5">
            <div>
                <label class="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5 ml-1">Usuario</label>
                <input type="text" id="login-user" class="w-full bg-gray-50 border border-gray-200 text-gray-900 text-sm rounded-xl focus:ring-2 focus:ring-primary focus:border-primary block p-3 font-bold outline-none shadow-inner transition-all" placeholder="ID de Usuario" autocomplete="off">
            </div>
            <div>
                <label class="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5 ml-1">Contraseña</label>
                <input type="password" id="login-pass" class="w-full bg-gray-50 border border-gray-200 text-gray-900 text-sm rounded-xl focus:ring-2 focus:ring-primary focus:border-primary block p-3 font-bold outline-none shadow-inner transition-all" placeholder="••••••••" onkeydown="if(event.key === 'Enter') procesarLogin()">
            </div>
            
            <button id="btn-login" onclick="procesarLogin()" class="w-full bg-primary text-white font-black text-sm rounded-xl p-3.5 mt-2 hover:bg-blue-800 transition-colors shadow-md flex justify-center items-center gap-2">
                Ingresar al Sistema
            </button>
        </div>
        
        <div id="login-error" class="hidden mt-4 p-3 bg-red-50 border border-red-200 text-red-600 text-xs font-bold rounded-lg text-center"></div>
        <div id="login-render-notice" class="hidden mt-4 text-[10px] text-gray-400 text-center font-medium animate-pulse">
            Iniciando conexión segura con el servidor...
        </div>
    </div>
</div>
`;

window.inicializarModuloAuth = function() {
    const token = localStorage.getItem('eor_session_token');
    const container = document.getElementById('auth-container');
    
    if (!token) {
        // Inyectamos la barrera solo si no hay sesión
        if(container) container.innerHTML = HTML_LOGIN;
    } else {
        // Pasa directo sin tocar el DOM
        desbloquearSistema();
    }
};

window.procesarLogin = function() {
    const user = document.getElementById('login-user').value.trim();
    const pass = document.getElementById('login-pass').value.trim();
    const btn = document.getElementById('btn-login');
    const errorBox = document.getElementById('login-error');
    const renderNotice = document.getElementById('login-render-notice');
    
    if (!user || !pass) {
        errorBox.innerText = "Complete ambos campos.";
        errorBox.classList.remove('hidden');
        return;
    }

    // Feedback inmediato
    btn.innerHTML = `<span class="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span> Conectando...`;
    btn.disabled = true;
    errorBox.classList.add('hidden');

    // Manejo inteligente del Cold Start de Render
    const timeoutRender = setTimeout(() => {
        if(renderNotice) renderNotice.classList.remove('hidden');
        btn.innerHTML = `<span class="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span> Despertando DB...`;
    }, 2500);

    const apiUrl = typeof API_URL !== 'undefined' ? API_URL : "https://diagramasnode.onrender.com/api/proxy";

    fetch(apiUrl, {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: 'login', usuario: user, password: pass })
    })
    .then(res => res.json())
    .then(res => {
        clearTimeout(timeoutRender);
        if(renderNotice) renderNotice.classList.add('hidden');

        if (res.success) {
            localStorage.setItem('eor_session_token', res.token);
            localStorage.setItem('eor_session_role', res.rol);
            localStorage.setItem('usuarioActivo', user); 
            desbloquearSistema();
        } else {
            errorBox.innerText = res.error || "Acceso denegado.";
            errorBox.classList.remove('hidden');
            btn.innerHTML = "Ingresar al Sistema";
            btn.disabled = false;
        }
    })
    .catch(err => {
        clearTimeout(timeoutRender);
        if(renderNotice) renderNotice.classList.add('hidden');
        errorBox.innerText = "Error de red. Intente nuevamente.";
        errorBox.classList.remove('hidden');
        btn.innerHTML = "Ingresar al Sistema";
        btn.disabled = false;
        console.error("Error en Fetch Login:", err);
    });
};

window.desbloquearSistema = function() {
    const wall = document.getElementById('login-wall');
    
    if (wall) {
        // Animación suave si el login estaba abierto
        wall.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => {
            const container = document.getElementById('auth-container');
            if(container) container.innerHTML = ''; // Destrucción total del nodo
        }, 500);
    }
    
    // Motor de arranque principal
    if (typeof cargarDatosDesdeCache === 'function') {
        cargarDatosDesdeCache(); 
    }
};

window.cerrarSesion = function() {
    // Purga absoluta
    localStorage.removeItem('eor_session_token');
    localStorage.removeItem('eor_session_role');
    localStorage.removeItem('usuarioActivo');
    
    // Limpieza de Deep Linking para no quedar atrapado en una vista
    const urlLimpia = new URL(window.location);
    urlLimpia.searchParams.delete('chofer');
    window.history.replaceState({}, '', urlLimpia);
    
    // Reseteo duro (La mejor práctica para asegurar que la RAM se libere)
    location.reload();
};
