require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const SEMANAS_ORDEN = ["S02", "S03", "S04", "S07", "S08", "S11", "S12", "Evaluaciones"];
const URL_LOGIN = "https://9002.edusalta.gov.ar/login/index.php";

// Estado del bot en memoria para consultar desde el celular
let estadoBot = { ejecutando: false, progreso: 'Inactivo', procesados: 0, total: 0 };

// ============================================================================
// 1. GESTIÓN DE ALUMNOS (Listar, Agregar, Editar, Borrar)
// ============================================================================

// Obtener alumnos de una cursada
app.get('/api/alumnos_cursada', async (req, res) => {
    try {
        const { modulo, orientacion, anio = 2026, periodo = '2° Período' } = req.query;
        const query = `
            SELECT a.id as alumno_id, a.dni, a.contrasena_moodle, a.nombre_completo, a.email, a.telefono,
                   a.doc_dni, a.doc_foto_carnet, a.doc_certificado_residencia, a.doc_constancia_pase, a.doc_pase_legalizado, a.doc_certificado_septimo,
                   c.id as cursada_id, c.numero_modulo, c.orientacion, c.debe_defensa, c.seguimiento_semanal, c.resumen_texto
            FROM alumnos a
            JOIN cursadas_modulos c ON a.id = c.alumno_id
            WHERE a.estado_general = 'Activo'
              AND c.numero_modulo = $1
              AND c.orientacion = $2
              AND c.anio = $3
              AND c.periodo = $4
            ORDER BY a.nombre_completo ASC
        `;
        const result = await pool.query(query, [modulo, orientacion, anio, periodo]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener alumnos' });
    }
});

// Crear nuevo alumno y asignarlo al módulo/orientación actual
app.post('/api/alumnos', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { dni, nombre_completo, contrasena_moodle, email, telefono, numero_modulo, orientacion, anio = 2026, periodo = '2° Período' } = req.body;

        // 1. Insertar o actualizar en tabla alumnos
        const resAlumno = await client.query(
            `INSERT INTO alumnos (dni, nombre_completo, contrasena_moodle, email, telefono, estado_general)
             VALUES ($1, $2, $3, $4, $5, 'Activo')
             ON CONFLICT (dni) DO UPDATE SET 
                nombre_completo = EXCLUDED.nombre_completo,
                contrasena_moodle = EXCLUDED.contrasena_moodle,
                estado_general = 'Activo'
             RETURNING id`,
            [dni.trim(), nombre_completo.trim().toUpperCase(), contrasena_moodle.trim(), email || '', telefono || '']
        );
        const alumnoId = resAlumno.rows[0].id;

        // 2. Verificar si ya está en esta cursada, si no, insertarlo
        const checkCursada = await client.query(
            `SELECT id FROM cursadas_modulos WHERE alumno_id = $1 AND numero_modulo = $2 AND orientacion = $3 AND anio = $4 AND periodo = $5`,
            [alumnoId, numero_modulo, orientacion, anio, periodo]
        );

        if (checkCursada.rows.length === 0) {
            await client.query(
                `INSERT INTO cursadas_modulos (alumno_id, numero_modulo, orientacion, anio, periodo, debe_defensa)
                 VALUES ($1, $2, $3, $4, $5, FALSE)`,
                [alumnoId, numero_modulo, orientacion, anio, periodo]
            );
        }

        await client.query('COMMIT');
        res.json({ mensaje: 'Alumno registrado correctamente', alumno_id: alumnoId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al registrar alumno' });
    } finally {
        client.release();
    }
});

// Editar datos básicos, documentación y estado de defensa del alumno
app.put('/api/alumno/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;
        const { 
            dni, nombre_completo, contrasena_moodle, email, telefono, 
            doc_dni, doc_foto_carnet, doc_certificado_residencia, doc_constancia_pase, doc_pase_legalizado, doc_certificado_septimo,
            cursada_id, debe_defensa 
        } = req.body;

        await client.query(
            `UPDATE alumnos SET 
                dni = COALESCE($1, dni),
                nombre_completo = COALESCE($2, nombre_completo),
                contrasena_moodle = COALESCE($3, contrasena_moodle),
                email = $4, telefono = $5, doc_dni = $6, doc_foto_carnet = $7, 
                doc_certificado_residencia = $8, doc_constancia_pase = $9, doc_pase_legalizado = $10, doc_certificado_septimo = $11
             WHERE id = $12`,
            [dni, nombre_completo ? nombre_completo.toUpperCase() : null, contrasena_moodle, email, telefono, doc_dni, doc_foto_carnet, doc_certificado_residencia, doc_constancia_pase, doc_pase_legalizado, doc_certificado_septimo, id]
        );

        if (cursada_id !== undefined && debe_defensa !== undefined) {
            await client.query(`UPDATE cursadas_modulos SET debe_defensa = $1 WHERE id = $2`, [debe_defensa, cursada_id]);
        }

        await client.query('COMMIT');
        res.json({ mensaje: 'Legajo actualizado correctamente' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar legajo' });
    } finally {
        client.release();
    }
});

// Eliminar un alumno de la cursada actual (o dar de baja)
app.delete('/api/cursada/:cursada_id', async (req, res) => {
    try {
        const { cursada_id } = req.params;
        await pool.query('DELETE FROM cursadas_modulos WHERE id = $1', [cursada_id]);
        res.json({ mensaje: 'Alumno eliminado del módulo correctamente' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al eliminar alumno de la cursada' });
    }
});

// ============================================================================
// 2. ENLACES Y CONFIGURACIÓN DE MOODLE
// ============================================================================

app.get('/api/actividades', async (req, res) => {
    try {
        const { modulo, orientacion } = req.query;
        const result = await pool.query(
            `SELECT * FROM actividades_moodle 
             WHERE numero_modulo = $1 AND orientacion = $2 AND activa = TRUE 
             ORDER BY semana ASC, materia ASC`,
            [modulo, orientacion]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener actividades' });
    }
});

app.post('/api/actividades', async (req, res) => {
    try {
        const { numero_modulo, orientacion, semana, materia, tipo_actividad, url_actividad } = req.body;
        const result = await pool.query(
            `INSERT INTO actividades_moodle (numero_modulo, orientacion, semana, materia, tipo_actividad, url_actividad)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (numero_modulo, orientacion, semana, materia) 
             DO UPDATE SET url_actividad = EXCLUDED.url_actividad, tipo_actividad = EXCLUDED.tipo_actividad, activa = TRUE
             RETURNING *`,
            [numero_modulo, orientacion, semana, materia, tipo_actividad, url_actividad]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar actividad' });
    }
});

app.delete('/api/actividades/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM actividades_moodle WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Enlace eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar enlace' });
    }
});

app.get('/api/config_curso', async (req, res) => {
    try {
        const { modulo, orientacion } = req.query;
        const result = await pool.query('SELECT * FROM config_cursos_moodle WHERE numero_modulo = $1 AND orientacion = $2', [modulo, orientacion]);
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: 'Error config_curso' });
    }
});

app.post('/api/config_curso', async (req, res) => {
    try {
        const { numero_modulo, orientacion, url_calificaciones } = req.body;
        await pool.query(
            `INSERT INTO config_cursos_moodle (numero_modulo, orientacion, url_calificaciones)
             VALUES ($1, $2, $3)
             ON CONFLICT (numero_modulo, orientacion) DO UPDATE SET url_calificaciones = EXCLUDED.url_calificaciones`,
            [numero_modulo, orientacion, url_calificaciones]
        );
        res.json({ mensaje: 'URL de calificaciones guardada' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar URL de calificaciones' });
    }
});

// ============================================================================
// 3. GRUPOS Y PROYECTOS
// ============================================================================

app.get('/api/grupos', async (req, res) => {
    try {
        const { modulo, orientacion, anio = 2026, periodo = '2° Período' } = req.query;
        const query = `
            SELECT g.*, 
                   COALESCE(json_agg(
                       json_build_object('id', a.id, 'nombre_completo', a.nombre_completo)
                   ) FILTER (WHERE a.id IS NOT NULL), '[]') as integrantes
            FROM grupos_proyecto g
            LEFT JOIN grupo_integrantes gi ON g.id = gi.grupo_id
            LEFT JOIN alumnos a ON gi.alumno_id = a.id
            WHERE g.numero_modulo = $1 AND g.orientacion = $2 AND g.anio = $3 AND g.periodo = $4
            GROUP BY g.id 
            ORDER BY g.nombre_grupo ASC
        `;
        const result = await pool.query(query, [modulo, orientacion, anio, periodo]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener grupos' });
    }
});

app.post('/api/grupos', async (req, res) => {
    try {
        const { numero_modulo, orientacion, anio = 2026, periodo = '2° Período', nombre_grupo } = req.body;
        const result = await pool.query(
            `INSERT INTO grupos_proyecto (numero_modulo, orientacion, anio, periodo, nombre_grupo)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [numero_modulo, orientacion, anio, periodo, nombre_grupo]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al crear grupo' });
    }
});

app.delete('/api/grupos/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM grupo_integrantes WHERE grupo_id = $1', [req.params.id]);
        await pool.query('DELETE FROM grupos_proyecto WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Grupo eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar grupo' });
    }
});

app.post('/api/grupo/agregar_alumno', async (req, res) => {
    try {
        const { grupo_id, alumno_id } = req.body;
        const countRes = await pool.query('SELECT count(*) FROM grupo_integrantes WHERE grupo_id = $1', [grupo_id]);
        if (parseInt(countRes.rows[0].count) >= 4) {
            return res.status(400).json({ error: 'El grupo ya alcanzó el límite de 4 integrantes.' });
        }
        await pool.query('INSERT INTO grupo_integrantes (grupo_id, alumno_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [grupo_id, alumno_id]);
        res.json({ mensaje: 'Alumno agregado exitosamente' });
    } catch (err) {
        res.status(500).json({ error: 'Error al agregar alumno' });
    }
});

app.delete('/api/grupo/quitar_alumno/:grupo_id/:alumno_id', async (req, res) => {
    try {
        const { grupo_id, alumno_id } = req.params;
        await pool.query('DELETE FROM grupo_integrantes WHERE grupo_id = $1 AND alumno_id = $2', [grupo_id, alumno_id]);
        res.json({ mensaje: 'Alumno retirado del grupo' });
    } catch (err) {
        res.status(500).json({ error: 'Error al quitar alumno' });
    }
});

app.put('/api/grupos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { tema_proyecto, instancia_1, instancia_2, instancia_3, instancia_recuperacion, estado_defensa, nota_final, observaciones_grupo } = req.body;
        await pool.query(
            `UPDATE grupos_proyecto SET 
             tema_proyecto = $1, instancia_1 = $2, instancia_2 = $3, instancia_3 = $4, 
             instancia_recuperacion = $5, estado_defensa = $6, nota_final = $7, observaciones_grupo = $8
             WHERE id = $9`,
            [tema_proyecto, instancia_1, instancia_2, instancia_3, instancia_recuperacion, estado_defensa, nota_final, observaciones_grupo, id]
        );
        res.json({ mensaje: 'Notas actualizadas' });
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar grupo' });
    }
});

// ============================================================================
// 4. BOT INTEGRADO EN EL SERVIDOR (Para ejecutar desde el Celular o PC)
// ============================================================================

app.get('/api/bot/estado', (req, res) => {
    res.json(estadoBot);
});

app.post('/api/ejecutar_bot', async (req, res) => {
    if (estadoBot.ejecutando) {
        return res.status(400).json({ error: 'El bot ya se está ejecutando en este momento.' });
    }

    const { modulo, orientacion, anio = 2026, periodo = '2° Período' } = req.body;
    res.json({ mensaje: 'Bot iniciado en segundo plano' });

    // Ejecución asíncrona en segundo plano
    ejecutarScrapingMoodle(modulo, orientacion, anio, periodo);
});

async function ejecutarScrapingMoodle(modulo, orientacion, anio, periodo) {
    estadoBot = { ejecutando: true, progreso: 'Iniciando barrido...', procesados: 0, total: 0 };
    try {
        const resAlumnos = await pool.query(
            `SELECT a.dni, a.contrasena_moodle, a.nombre_completo, c.id as cursada_id
             FROM alumnos a JOIN cursadas_modulos c ON a.id = c.alumno_id
             WHERE a.estado_general = 'Activo' AND c.numero_modulo = $1 AND c.orientacion = $2 AND c.anio = $3 AND c.periodo = $4
             ORDER BY a.nombre_completo ASC`,
            [modulo, orientacion, anio, periodo]
        );
        const alumnos = resAlumnos.rows;
        estadoBot.total = alumnos.length;

        const resAct = await pool.query(
            `SELECT * FROM actividades_moodle WHERE numero_modulo = $1 AND orientacion = $2 AND activa = TRUE`,
            [modulo, orientacion]
        );
        const actividadesDirectas = resAct.rows;

        const resConf = await pool.query(
            `SELECT url_calificaciones FROM config_cursos_moodle WHERE numero_modulo = $1 AND orientacion = $2`,
            [modulo, orientacion]
        );
        const urlCalificaciones = resConf.rows[0]?.url_calificaciones || 'https://9002.edusalta.gov.ar/grade/report/user/index.php?id=71';

        for (let i = 0; i < alumnos.length; i++) {
            const al = alumnos[i];
            estadoBot.progreso = `Procesando: ${al.nombre_completo} (${i + 1}/${alumnos.length})`;
            estadoBot.procesados = i + 1;

            try {
                const jar = new CookieJar();
                const client = wrapper(axios.create({ jar, withCredentials: true, timeout: 15000 }));

                // 1. Obtener logintoken de Moodle
                const getLogin = await client.get(URL_LOGIN);
                const $login = cheerio.load(getLogin.data);
                const logintoken = $login('input[name="logintoken"]').val() || '';

                // 2. Enviar credenciales
                const params = new URLSearchParams();
                params.append('username', String(al.dni).trim());
                params.append('password', String(al.contrasena_moodle).trim());
                if (logintoken) params.append('logintoken', logintoken);

                await client.post(URL_LOGIN, params.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                let datosSemanas = {};
                SEMANAS_ORDEN.forEach(s => datosSemanas[s] = { completas: [], faltan: [] });

                // PASO A: Tabla General de Calificaciones
                if (urlCalificaciones) {
                    const getGrades = await client.get(urlCalificaciones);
                    const $grades = cheerio.load(getGrades.data);

                    $grades('tr').each((_, el) => {
                        const textoFila = $grades(el).text().replace(/\s+/g, ' ').trim();
                        if (!textoFila || textoFila.includes('Cálculo total') || textoFila.includes('Total')) return;

                        const semEncontrada = SEMANAS_ORDEN.find(sem => textoFila.includes(sem));
                        if (semEncontrada) {
                            let materiaLimpia = textoFila.split('_')[0].replace(/CUESTIONARIO|TAREA/gi, '').trim();
                            if (materiaLimpia.length > 25) materiaLimpia = materiaLimpia.substring(0, 25);

                            const simbolosOk = ["%", "✓", "✔", "✗", "✘"];
                            const hecha = simbolosOk.some(s => textoFila.includes(s)) && !textoFila.includes("Vacío") && !textoFila.includes("-");

                            if (hecha) {
                                if (!datosSemanas[semEncontrada].completas.includes(materiaLimpia)) datosSemanas[semEncontrada].completas.push(materiaLimpia);
                            } else {
                                if (!datosSemanas[semEncontrada].faltan.includes(materiaLimpia)) datosSemanas[semEncontrada].faltan.push(materiaLimpia);
                            }
                        }
                    });
                }

                // PASO B: Enlaces Directos por Semana
                for (const act of actividadesDirectas) {
                    const sem = act.semana;
                    const mat = act.materia;
                    const urlAct = act.url_actividad;

                    if (!datosSemanas[sem]) continue;
                    datosSemanas[sem].completas = datosSemanas[sem].completas.filter(m => m !== mat);
                    datosSemanas[sem].faltan = datosSemanas[sem].faltan.filter(m => m !== mat);

                    if (urlAct === 'Revisión_Manual') {
                        datosSemanas[sem].completas.push(`${mat} (Colaborativa)`);
                        continue;
                    }

                    const getAct = await client.get(urlAct);
                    const textoPag = cheerio.load(getAct.data)('body').text();

                    const palabrasCompletado = [
                        "Finalizado", "Enviado para calificar", "Archivos enviados", 
                        "Texto en línea", "Calificación", "Hecho: Recibir una calificación", "Intentos: 1"
                    ];

                    if (palabrasCompletado.some(p => textoPag.includes(p))) {
                        datosSemanas[sem].completas.push(mat);
                    } else {
                        datosSemanas[sem].faltan.push(mat);
                    }
                }

                // PASO C: Armar texto de resumen y guardar en Neon
                let detallesTexto = [];
                for (const sem of SEMANAS_ORDEN) {
                    const cComp = datosSemanas[sem].completas.length;
                    const cFalt = datosSemanas[sem].faltan.length;
                    if (cComp > 0 || cFalt > 0) {
                        const etiqueta = sem === "Evaluaciones" ? "Evaluaciones" : `Semana ${sem.replace('S0', '').replace('S', '')}`;
                        let estado = "";
                        if (cFalt === 0) estado = "COMPLETA";
                        else if (cComp === 0) estado = "No realizó nada";
                        else estado = `Falta realizar ${datosSemanas[sem].faltan.join(', ').toLowerCase()}`;
                        detallesTexto.push(`${etiqueta}: ${estado}`);
                    }
                }

                const resumenFinal = detallesTexto.length > 0 
                    ? `${al.nombre_completo.toUpperCase()}: ${detallesTexto.join(' - ')}`
                    : `${al.nombre_completo.toUpperCase()}: Sin registros`;

                await pool.query(
                    `UPDATE cursadas_modulos SET seguimiento_semanal = $1, resumen_texto = $2, ultima_actualizacion_bot = CURRENT_TIMESTAMP WHERE id = $3`,
                    [datosSemanas, resumenFinal, al.cursada_id]
                );

            } catch (errAl) {
                console.error(`Error procesando alumno ${al.nombre_completo}:`, errAl.message);
            }
        }
        estadoBot = { ejecutando: false, progreso: '¡Seguimiento completado con éxito!', procesados: alumnos.length, total: alumnos.length };
    } catch (errGral) {
        console.error("Error general del bot:", errGral);
        estadoBot = { ejecutando: false, progreso: 'Error al ejecutar el bot', procesados: 0, total: 0 };
    }
}

// Endpoint manual por si seguís usando el script de Python en PC
app.put('/api/seguimiento', async (req, res) => {
    try {
        const { cursada_id, seguimiento_json, resumen_texto } = req.body;
        await pool.query(
            `UPDATE cursadas_modulos SET seguimiento_semanal = $1, resumen_texto = $2, ultima_actualizacion_bot = CURRENT_TIMESTAMP WHERE id = $3`,
            [seguimiento_json, resumen_texto, cursada_id]
        );
        res.json({ mensaje: 'Seguimiento actualizado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar seguimiento' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor API corriendo en el puerto ${PORT}`);
});