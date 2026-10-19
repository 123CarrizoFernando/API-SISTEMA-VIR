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

let estadoBot = { ejecutando: false, progreso: 'Inactivo', procesados: 0, total: 0 };

// ============================================================================
// 0. AUTENTICACIÓN Y GESTIÓN DE USUARIOS (ALQUILERES POR SEDE Y MÓDULO)
// ============================================================================

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query(
            `SELECT id, username, nombre_completo, rol, sede, modulos_permitidos, activo 
             FROM usuarios_sistema 
             WHERE LOWER(username) = LOWER($1) AND password = $2`,
            [username.trim(), password.trim()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        }

        const user = result.rows[0];
        if (!user.activo) {
            return res.status(403).json({ error: 'Tu cuenta se encuentra suspendida temporalmente. Contactá al administrador.' });
        }

        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error en el servidor al iniciar sesión' });
    }
});

app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM usuarios_sistema ORDER BY sede ASC, nombre_completo ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

app.post('/api/usuarios', async (req, res) => {
    try {
        const { username, password, nombre_completo, rol, sede, modulos_permitidos, activo } = req.body;
        const result = await pool.query(
            `INSERT INTO usuarios_sistema (username, password, nombre_completo, rol, sede, modulos_permitidos, activo)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (username) DO UPDATE SET 
                password = EXCLUDED.password,
                nombre_completo = EXCLUDED.nombre_completo,
                rol = EXCLUDED.rol,
                sede = EXCLUDED.sede,
                modulos_permitidos = EXCLUDED.modulos_permitidos,
                activo = EXCLUDED.activo
             RETURNING *`,
            [username.trim(), password.trim(), nombre_completo.trim(), rol || 'facilitador', sede, modulos_permitidos, activo ?? true]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar usuario: ' + err.message });
    }
});

app.delete('/api/usuarios/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM usuarios_sistema WHERE id = $1 AND username != 'admin'", [req.params.id]);
        res.json({ mensaje: 'Usuario eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar usuario' });
    }
});

// ============================================================================
// 1. GESTIÓN DE ALUMNOS (FILTRADO POR SEDE, MÓDULO, ORIENTACIÓN, AÑO Y PERÍODO)
// ============================================================================

app.get('/api/alumnos_cursada', async (req, res) => {
    try {
        const { sede = 'Tartagal', modulo, orientacion, anio = 2026, periodo = '2° Período' } = req.query;
        const query = `
            SELECT a.id as alumno_id, a.dni, a.contrasena_moodle, a.nombre_completo, a.email, a.telefono,
                   a.doc_dni, a.doc_foto_carnet, a.doc_certificado_residencia, a.doc_constancia_pase, a.doc_pase_legalizado, a.doc_certificado_septimo,
                   COALESCE(a.modulos_adeudados, '') as modulos_adeudados, COALESCE(a.egresado, FALSE) as egresado,
                   c.id as cursada_id, c.numero_modulo, c.orientacion, c.anio, c.periodo, COALESCE(c.sede, 'Tartagal') as sede,
                   c.debe_defensa, COALESCE(c.condicion, 'Cursando') as condicion,
                   COALESCE(c.notificado_libre, FALSE) as notificado_libre,
                   COALESCE(c.presento_nota_recursar, FALSE) as presento_nota_recursar,
                   c.seguimiento_semanal, c.resumen_texto
            FROM alumnos a
            JOIN cursadas_modulos c ON a.id = c.alumno_id
            WHERE a.estado_general = 'Activo'
              AND c.numero_modulo = $1
              AND c.orientacion = $2
              AND c.anio = $3
              AND c.periodo = $4
              AND COALESCE(c.sede, 'Tartagal') = $5
            ORDER BY a.nombre_completo ASC
        `;
        const result = await pool.query(query, [modulo, orientacion, anio, periodo, sede]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener alumnos' });
    }
});

app.get('/api/alumno/:id/historial', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id as cursada_id, numero_modulo, orientacion, anio, periodo, COALESCE(sede, 'Tartagal') as sede,
                    COALESCE(condicion, 'Cursando') as condicion, debe_defensa, 
                    notificado_libre, presento_nota_recursar, resumen_texto
             FROM cursadas_modulos 
             WHERE alumno_id = $1 
             ORDER BY anio DESC, periodo DESC, numero_modulo DESC`,
            [id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener historial' });
    }
});

app.put('/api/cursada/:cursada_id/estado_academico', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { cursada_id } = req.params;
        const { alumno_id, condicion, debe_defensa, notificado_libre, presento_nota_recursar, modulos_adeudados, egresado } = req.body;

        await client.query(
            `UPDATE cursadas_modulos SET 
                condicion = $1, debe_defensa = $2, notificado_libre = $3, presento_nota_recursar = $4
             WHERE id = $5`,
            [condicion, debe_defensa, notificado_libre, presento_nota_recursar, cursada_id]
        );

        await client.query(
            `UPDATE alumnos SET modulos_adeudados = $1, egresado = $2 WHERE id = $3`,
            [modulos_adeudados || '', egresado || false, alumno_id]
        );

        await client.query('COMMIT');
        res.json({ mensaje: 'Estado académico actualizado correctamente' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error al actualizar estado académico' });
    } finally {
        client.release();
    }
});

app.post('/api/alumnos', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { dni, nombre_completo, contrasena_moodle, email, telefono, numero_modulo, orientacion, anio = 2026, periodo = '2° Período', sede = 'Tartagal' } = req.body;

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

        const checkCursada = await client.query(
            `SELECT id FROM cursadas_modulos WHERE alumno_id = $1 AND numero_modulo = $2 AND orientacion = $3 AND anio = $4 AND periodo = $5 AND COALESCE(sede, 'Tartagal') = $6`,
            [alumnoId, numero_modulo, orientacion, anio, periodo, sede]
        );

        if (checkCursada.rows.length === 0) {
            await client.query(
                `INSERT INTO cursadas_modulos (alumno_id, numero_modulo, orientacion, anio, periodo, sede, debe_defensa, condicion)
                 VALUES ($1, $2, $3, $4, $5, $6, FALSE, 'Cursando')`,
                [alumnoId, numero_modulo, orientacion, anio, periodo, sede]
            );
        }

        await client.query('COMMIT');
        res.json({ mensaje: 'Alumno registrado', alumno_id: alumnoId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error al registrar alumno' });
    } finally {
        client.release();
    }
});

app.post('/api/alumnos/masivo', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { alumnos, numero_modulo, orientacion, anio = 2026, periodo = '2° Período', sede = 'Tartagal' } = req.body;
        let procesados = 0;

        for (const al of alumnos) {
            if (!al.dni || !al.nombre_completo) continue;
            const dniLimpio = String(al.dni).replace(/\./g, '').trim();
            const nombreLimpio = String(al.nombre_completo).trim().toUpperCase();
            const claveLimpia = (al.contrasena_moodle && String(al.contrasena_moodle).trim() !== '') 
                ? String(al.contrasena_moodle).trim() 
                : dniLimpio;

            const resAlumno = await client.query(
                `INSERT INTO alumnos (dni, nombre_completo, contrasena_moodle, estado_general)
                 VALUES ($1, $2, $3, 'Activo')
                 ON CONFLICT (dni) DO UPDATE SET 
                    nombre_completo = EXCLUDED.nombre_completo,
                    contrasena_moodle = EXCLUDED.contrasena_moodle,
                    estado_general = 'Activo'
                 RETURNING id`,
                [dniLimpio, nombreLimpio, claveLimpia]
            );
            const alumnoId = resAlumno.rows[0].id;

            const checkCursada = await client.query(
                `SELECT id FROM cursadas_modulos WHERE alumno_id = $1 AND numero_modulo = $2 AND orientacion = $3 AND anio = $4 AND periodo = $5 AND COALESCE(sede, 'Tartagal') = $6`,
                [alumnoId, numero_modulo, orientacion, anio, periodo, sede]
            );

            if (checkCursada.rows.length === 0) {
                await client.query(
                    `INSERT INTO cursadas_modulos (alumno_id, numero_modulo, orientacion, anio, periodo, sede, debe_defensa, condicion)
                     VALUES ($1, $2, $3, $4, $5, $6, FALSE, 'Cursando')`,
                    [alumnoId, numero_modulo, orientacion, anio, periodo, sede]
                );
            }
            procesados++;
        }

        await client.query('COMMIT');
        res.json({ mensaje: `¡Se procesaron ${procesados} alumnos en ${sede} (${anio} - ${periodo})!`, cantidad: procesados });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error en carga masiva: ' + err.message });
    } finally {
        client.release();
    }
});

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
        res.status(500).json({ error: 'Error al actualizar legajo' });
    } finally {
        client.release();
    }
});

app.delete('/api/cursada/:cursada_id', async (req, res) => {
    try {
        await pool.query('DELETE FROM cursadas_modulos WHERE id = $1', [req.params.cursada_id]);
        res.json({ mensaje: 'Alumno eliminado de este período' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar alumno' });
    }
});

// ============================================================================
// 2. ENLACES MOODLE (COMPARTIDOS POR MÓDULO Y ORIENTACIÓN PARA TODA LA PROVINCIA)
// ============================================================================

app.get('/api/actividades', async (req, res) => {
    try {
        const { modulo, orientacion } = req.query;
        const result = await pool.query(
            `SELECT * FROM actividades_moodle WHERE numero_modulo = $1 AND orientacion = $2 AND activa = TRUE ORDER BY semana ASC, materia ASC`,
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
        const existe = await pool.query(
            `SELECT id FROM actividades_moodle WHERE numero_modulo = $1 AND orientacion = $2 AND semana = $3 AND materia = $4`,
            [numero_modulo, orientacion, semana, materia]
        );

        let result;
        if (existe.rows.length > 0) {
            result = await pool.query(
                `UPDATE actividades_moodle SET tipo_actividad = $1, url_actividad = $2, activa = TRUE WHERE id = $3 RETURNING *`,
                [tipo_actividad, url_actividad, existe.rows[0].id]
            );
        } else {
            result = await pool.query(
                `INSERT INTO actividades_moodle (numero_modulo, orientacion, semana, materia, tipo_actividad, url_actividad, activa)
                 VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
                [numero_modulo, orientacion, semana, materia, tipo_actividad, url_actividad]
            );
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        const existe = await pool.query('SELECT id FROM config_cursos_moodle WHERE numero_modulo = $1 AND orientacion = $2', [numero_modulo, orientacion]);
        if (existe.rows.length > 0) {
            await pool.query('UPDATE config_cursos_moodle SET url_calificaciones = $1 WHERE id = $2', [url_calificaciones, existe.rows[0].id]);
        } else {
            await pool.query('INSERT INTO config_cursos_moodle (numero_modulo, orientacion, url_calificaciones) VALUES ($1, $2, $3)', [numero_modulo, orientacion, url_calificaciones]);
        }
        res.json({ mensaje: 'URL guardada' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar URL' });
    }
});

// ============================================================================
// 3. GRUPOS Y PROYECTOS (AISLADOS POR SEDE)
// ============================================================================

app.get('/api/grupos', async (req, res) => {
    try {
        const { sede = 'Tartagal', modulo, orientacion, anio = 2026, periodo = '2° Período' } = req.query;
        const query = `
            SELECT g.*, 
                   COALESCE(json_agg(
                       json_build_object('id', a.id, 'nombre_completo', a.nombre_completo)
                   ) FILTER (WHERE a.id IS NOT NULL), '[]') as integrantes
            FROM grupos_proyecto g
            LEFT JOIN grupo_integrantes gi ON g.id = gi.grupo_id
            LEFT JOIN alumnos a ON gi.alumno_id = a.id
            WHERE g.numero_modulo = $1 AND g.orientacion = $2 AND g.anio = $3 AND g.periodo = $4
              AND COALESCE(g.sede, 'Tartagal') = $5
            GROUP BY g.id ORDER BY g.nombre_grupo ASC
        `;
        const result = await pool.query(query, [modulo, orientacion, anio, periodo, sede]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener grupos' });
    }
});

app.post('/api/grupos', async (req, res) => {
    try {
        const { numero_modulo, orientacion, anio = 2026, periodo = '2° Período', sede = 'Tartagal', nombre_grupo } = req.body;
        const result = await pool.query(
            `INSERT INTO grupos_proyecto (numero_modulo, orientacion, anio, periodo, sede, nombre_grupo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [numero_modulo, orientacion, anio, periodo, sede, nombre_grupo]
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
        if (parseInt(countRes.rows[0].count) >= 4) return res.status(400).json({ error: 'El grupo ya tiene 4 integrantes.' });
        await pool.query('INSERT INTO grupo_integrantes (grupo_id, alumno_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [grupo_id, alumno_id]);
        res.json({ mensaje: 'Alumno agregado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al agregar alumno' });
    }
});

app.delete('/api/grupo/quitar_alumno/:grupo_id/:alumno_id', async (req, res) => {
    try {
        await pool.query('DELETE FROM grupo_integrantes WHERE grupo_id = $1 AND alumno_id = $2', [req.params.grupo_id, req.params.alumno_id]);
        res.json({ mensaje: 'Alumno retirado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al quitar alumno' });
    }
});

app.put('/api/grupos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { tema_proyecto, instancia_1, instancia_2, instancia_3, instancia_recuperacion, estado_defensa, nota_final, observaciones_grupo } = req.body;
        await pool.query(
            `UPDATE grupos_proyecto SET tema_proyecto = $1, instancia_1 = $2, instancia_2 = $3, instancia_3 = $4, 
             instancia_recuperacion = $5, estado_defensa = $6, nota_final = $7, observaciones_grupo = $8 WHERE id = $9`,
            [tema_proyecto, instancia_1, instancia_2, instancia_3, instancia_recuperacion, estado_defensa, nota_final, observaciones_grupo, id]
        );
        res.json({ mensaje: 'Notas actualizadas' });
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar grupo' });
    }
});

// ============================================================================
// 4. BOT MOODLE (AISLADO POR SEDE Y SELECCIÓN DE ALUMNOS)
// ============================================================================

app.get('/api/bot/estado', (req, res) => {
    res.json(estadoBot);
});

app.post('/api/bot/cancelar', (req, res) => {
    estadoBot = { ejecutando: false, progreso: 'Bot reiniciado manualmente.', procesados: 0, total: 0 };
    res.json({ mensaje: 'Bot desbloqueado' });
});

app.post('/api/ejecutar_bot', async (req, res) => {
    const { sede = 'Tartagal', modulo, orientacion, anio = 2026, periodo = '2° Período', cursada_ids = [], forzar = false } = req.body;

    if (estadoBot.ejecutando && !forzar) {
        return res.status(400).json({ error: 'El bot ya se está ejecutando en este momento.' });
    }

    res.json({ mensaje: 'Bot iniciado' });
    ejecutarScrapingMoodle(sede, modulo, orientacion, anio, periodo, cursada_ids);
});

function extraerMateriaLimpia(textoFila) {
    const l = textoFila.toLowerCase();
    if (l.includes('sociales') || l.includes('cs. soc')) return 'Cs. Sociales';
    if (l.includes('naturales') || l.includes('cs. nat')) return 'Cs. Naturales';
    if (l.includes('matem')) return 'Matemática';
    if (l.includes('lengua')) return 'Lengua';
    if (l.includes('fpt') || l.includes('formaci')) return 'FpT';
    return textoFila.split(/[_-]/)[0].replace(/CUESTIONARIO|TAREA/gi, '').trim().substring(0, 20);
}

async function ejecutarScrapingMoodle(sede, modulo, orientacion, anio, periodo, cursadaIds) {
    estadoBot = { ejecutando: true, progreso: `Preparando alumnos de ${sede}...`, procesados: 0, total: 0 };
    try {
        let query = `
            SELECT a.dni, a.contrasena_moodle, a.nombre_completo, c.id as cursada_id
            FROM alumnos a JOIN cursadas_modulos c ON a.id = c.alumno_id
            WHERE a.estado_general = 'Activo' AND c.numero_modulo = $1 AND c.orientacion = $2 AND c.anio = $3 AND c.periodo = $4
              AND COALESCE(c.sede, 'Tartagal') = $5
        `;
        let params = [modulo, orientacion, anio, periodo, sede];

        if (Array.isArray(cursadaIds) && cursadaIds.length > 0) {
            query += ` AND c.id = ANY($6::int[])`;
            params.push(cursadaIds);
        }
        query += ` ORDER BY a.nombre_completo ASC`;

        const resAlumnos = await pool.query(query, params);
        const alumnos = resAlumnos.rows;
        estadoBot.total = alumnos.length;

        const resAct = await pool.query(`SELECT * FROM actividades_moodle WHERE numero_modulo = $1 AND orientacion = $2 AND activa = TRUE`, [modulo, orientacion]);
        const actividadesDirectas = resAct.rows;

        const resConf = await pool.query(`SELECT url_calificaciones FROM config_cursos_moodle WHERE numero_modulo = $1 AND orientacion = $2`, [modulo, orientacion]);
        const urlCalificaciones = resConf.rows[0]?.url_calificaciones || 'https://9002.edusalta.gov.ar/grade/report/user/index.php?id=71';

        for (let i = 0; i < alumnos.length; i++) {
            if (!estadoBot.ejecutando) break;
            const al = alumnos[i];
            estadoBot.progreso = `[${sede}] (${i + 1}/${alumnos.length}): ${al.nombre_completo}`;
            estadoBot.procesados = i + 1;

            try {
                const jar = new CookieJar();
                const client = wrapper(axios.create({ jar, withCredentials: true, timeout: 15000 }));

                const getLogin = await client.get(URL_LOGIN);
                const $login = cheerio.load(getLogin.data);
                const logintoken = $login('input[name="logintoken"]').val() || '';

                const formParams = new URLSearchParams();
                formParams.append('username', String(al.dni).trim());
                formParams.append('password', String(al.contrasena_moodle).trim());
                if (logintoken) formParams.append('logintoken', logintoken);

                await client.post(URL_LOGIN, formParams.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                let datosSemanas = {};
                SEMANAS_ORDEN.forEach(s => datosSemanas[s] = { completas: [], faltan: [] });

                if (urlCalificaciones) {
                    const getGrades = await client.get(urlCalificaciones);
                    const $grades = cheerio.load(getGrades.data);

                    $grades('tr').each((_, el) => {
                        const textoFila = $grades(el).text().replace(/\s+/g, ' ').trim();
                        if (!textoFila || textoFila.includes('Cálculo total') || textoFila.includes('Total')) return;

                        const semEncontrada = SEMANAS_ORDEN.find(sem => textoFila.toUpperCase().includes(sem));
                        if (semEncontrada) {
                            const materiaLimpia = extraerMateriaLimpia(textoFila);
                            const simbolosOk = ["%", "✓", "✔", "✗", "✘"];
                            const hecha = simbolosOk.some(s => textoFila.includes(s)) && !textoFila.includes("Vacío") && !textoFila.includes(" - ");

                            if (hecha) {
                                if (!datosSemanas[semEncontrada].completas.includes(materiaLimpia)) datosSemanas[semEncontrada].completas.push(materiaLimpia);
                            } else {
                                if (!datosSemanas[semEncontrada].faltan.includes(materiaLimpia)) datosSemanas[semEncontrada].faltan.push(materiaLimpia);
                            }
                        }
                    });
                }

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
                    const palabrasCompletado = ["Finalizado", "Enviado para calificar", "Archivos enviados", "Texto en línea", "Calificación", "Hecho: Recibir una calificación", "Intentos: 1"];

                    if (palabrasCompletado.some(p => textoPag.includes(p))) {
                        datosSemanas[sem].completas.push(mat);
                    } else {
                        datosSemanas[sem].faltan.push(mat);
                    }
                }

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
                console.error(`Error con ${al.nombre_completo}:`, errAl.message);
            }
        }
        estadoBot = { ejecutando: false, progreso: `¡Seguimiento de ${sede} completado!`, procesados: alumnos.length, total: alumnos.length };
    } catch (errGral) {
        estadoBot = { ejecutando: false, progreso: 'Error al ejecutar el bot', procesados: 0, total: 0 };
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor API corriendo en el puerto ${PORT}`));