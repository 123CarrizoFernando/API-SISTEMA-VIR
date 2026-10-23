require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Incluye Evaluaciones y S15_Recup (Recuperatorios Semana 15)
const SEMANAS_ORDEN = ["S02", "S03", "S04", "S07", "S08", "S11", "S12", "Evaluaciones", "S15_Recup"];
const SEMANAS_CURSADA = ["S02", "S03", "S04", "S07", "S08", "S11", "S12"];
const SEMANAS_EXAMENES = ["Evaluaciones", "S15_Recup"];

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

app.put('/api/usuarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password, nombre_completo, rol, sede, modulos_permitidos, activo } = req.body;
        const result = await pool.query(
            `UPDATE usuarios_sistema SET 
                username = COALESCE($1, username),
                password = COALESCE($2, password),
                nombre_completo = COALESCE($3, nombre_completo),
                rol = COALESCE($4, rol),
                sede = COALESCE($5, sede),
                modulos_permitidos = COALESCE($6, modulos_permitidos),
                activo = COALESCE($7, activo)
             WHERE id = $8 RETURNING *`,
            [
                username ? username.trim() : null, 
                password ? password.trim() : null, 
                nombre_completo ? nombre_completo.trim() : null, 
                rol, sede, modulos_permitidos, activo, id
            ]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar usuario: ' + err.message });
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
// 2. ENLACES MOODLE
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
// 3. GRUPOS Y PROYECTOS
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
// 4. BOT MOODLE (CON MODO "SOLO EVALUACIONES", NOTA >= 6 Y SEMANA 15 RECUPERATORIOS)
// ============================================================================

app.get('/api/bot/estado', (req, res) => {
    res.json(estadoBot);
});

app.post('/api/bot/cancelar', (req, res) => {
    estadoBot = { ejecutando: false, progreso: 'Bot reiniciado manualmente.', procesados: 0, total: 0 };
    res.json({ mensaje: 'Bot desbloqueado' });
});

app.post('/api/ejecutar_bot', async (req, res) => {
    const {
        sede = 'Tartagal',
        modulo,
        orientacion,
        anio = 2026,
        periodo = '2° Período',
        cursada_ids = [],
        forzar = false,
        solo_evaluaciones = false
    } = req.body;

    if (estadoBot.ejecutando && !forzar) {
        return res.status(400).json({ error: 'El bot ya se está ejecutando en este momento.' });
    }

    res.json({ mensaje: solo_evaluaciones ? 'Seguimiento exclusivo de Evaluaciones iniciado' : 'Seguimiento completo iniciado' });
    ejecutarScrapingMoodle(sede, modulo, orientacion, anio, periodo, cursada_ids, solo_evaluaciones);
});

function extraerMateriaLimpia(textoFila) {
    const l = String(textoFila || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (l.includes('soc')) return 'Cs. Sociales';
    if (l.includes('nat')) return 'Cs. Naturales';
    if (l.includes('mat')) return 'Matemática';
    if (l.includes('len')) return 'Lengua';
    if (l.includes('fpt') || l.includes('formaci') || l.includes('trab')) return 'FpT';
    return null;
}

function detectarSemanaEnTexto(textoFila) {
    const t = String(textoFila || '').toUpperCase();
    if (/S\s*0?2\b|SEMANA\s*0?2\b/.test(t)) return 'S02';
    if (/S\s*0?3\b|SEMANA\s*0?3\b/.test(t)) return 'S03';
    if (/S\s*0?4\b|SEMANA\s*0?4\b/.test(t)) return 'S04';
    if (/S\s*0?7\b|SEMANA\s*0?7\b/.test(t)) return 'S07';
    if (/S\s*0?8\b|SEMANA\s*0?8\b/.test(t)) return 'S08';
    if (/S\s*11\b|SEMANA\s*11\b/.test(t)) return 'S11';
    if (/S\s*12\b|SEMANA\s*12\b/.test(t)) return 'S12';
    if (t.includes('RECUP') || /S\s*15\b|SEMANA\s*15\b/.test(t)) return 'S15_Recup';
    if (t.includes('EVAL') || /S\s*13\b|SEMANA\s*13\b|S\s*14\b|SEMANA\s*14\b/.test(t)) return 'Evaluaciones';
    return null;
}

function mismaMateria(matA, matB) {
    const canon = (s) => {
        const l = String(s || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (l.includes('mat')) return 'matematica';
        if (l.includes('soc')) return 'sociales';
        if (l.includes('nat')) return 'naturales';
        if (l.includes('len')) return 'lengua';
        if (l.includes('fpt') || l.includes('trab') || l.includes('formaci')) return 'fpt';
        return l.replace(/[^a-z]/g, '');
    };
    return canon(matA) === canon(matB);
}

function extraerIdModuloUrl(url) {
    const match = String(url || '').match(/[?&]id=(\d+)/);
    return match ? match[1] : null;
}

// Convierte una nota en texto (ej: "8,50", "80.00%", "10.00") a número en escala 0 a 10
function parsearNotaEscala10(notaRaw) {
    if (notaRaw === null || notaRaw === undefined) return null;
    const str = String(notaRaw).trim();
    const match = str.match(/([0-9]+[.,]?[0-9]*)/);
    if (!match) return null;
    let val = parseFloat(match[1].replace(',', '.'));
    if (isNaN(val)) return null;
    // Si viene como porcentaje (ej. 80% o 66.67%), lo pasamos a escala de 10 (8.0 o 6.67)
    if (str.includes('%') || val > 10) {
        val = val / 10.0;
    }
    return Math.round(val * 100) / 100;
}

function formatearNota(num) {
    if (num === null || num === undefined || isNaN(num)) return null;
    return Number.isInteger(num) ? `${num}` : num.toFixed(2).replace(/\.00$/, '');
}

function evaluarFilaTablaCalificaciones($grades, filaEl) {
    const textoFila = $grades(filaEl).text().replace(/\s+/g, ' ').trim();
    if (!textoFila || textoFila.includes('Cálculo total') || textoFila.includes('Total del curso')) {
        return { realizada: false, nota: null, notaNum: null };
    }

    const celdaGrade = $grades(filaEl).find('td.column-grade').text().replace(/\s+/g, ' ').trim();
    const celdaPorc = $grades(filaEl).find('td.column-percentage').text().replace(/\s+/g, ' ').trim();
    const simbolosOk = ["%", "✓", "✔", "✗", "✘"];

    let realizada = false;
    let notaNum = null;

    if (celdaGrade && celdaGrade !== '-' && !celdaGrade.toLowerCase().includes('vacío') && !celdaGrade.toLowerCase().includes('vacio')) {
        notaNum = parsearNotaEscala10(celdaGrade);
        if (notaNum !== null) realizada = true;
    }

    if (notaNum === null && celdaPorc && celdaPorc !== '-' && !celdaPorc.toLowerCase().includes('vacío')) {
        notaNum = parsearNotaEscala10(celdaPorc + '%');
        if (notaNum !== null) realizada = true;
    }

    if (!realizada) {
        const tieneSimbolo = simbolosOk.some(s => textoFila.includes(s));
        const diceVacio = textoFila.includes('Vacío') || textoFila.includes('Vacio');
        if (tieneSimbolo && !diceVacio) {
            realizada = true;
            const matchPorc = textoFila.match(/([0-9]+[.,]?[0-9]*)\s*%/);
            if (matchPorc) notaNum = parsearNotaEscala10(matchPorc[1] + '%');
        }
    }

    return { realizada, nota: formatearNota(notaNum), notaNum };
}

function analizarPaginaActividadMoodle(htmlCrudo) {
    const $ = cheerio.load(htmlCrudo);

    let contenedor = $('#region-main');
    if (contenedor.length === 0) contenedor = $('div[role="main"]');
    if (contenedor.length === 0) contenedor = $('body');

    const textoPlano = contenedor.text()
        .replace(/\s+/g, ' ')
        .replace(/calificaci[oó]n para aprobar:\s*[0-9.,]+\s*de\s*[0-9.,]+/gi, '')
        .trim();
    const textoLower = textoPlano.toLowerCase();

    let notaNum = null;

    // 1. "Su calificación final en este cuestionario es 10.00/10.00" o "Calificación más alta: 8.00 / 10.00"
    const matchCalifFinal = textoPlano.match(/calificaci[oó]n (?:final en este cuestionario es|m[aá]s alta:?)\s*([0-9]+[.,]?[0-9]*)/i);
    if (matchCalifFinal) {
        notaNum = parsearNotaEscala10(matchCalifFinal[1]);
    }

    // 2. "Calificar 10.00 de 10.00" dentro del cuadro de intento
    if (notaNum === null) {
        const matchCalificarDe = textoPlano.match(/calificar\s+([0-9]+[.,]?[0-9]*)\s+de\s+[0-9]+/i);
        if (matchCalificarDe) {
            notaNum = parsearNotaEscala10(matchCalificarDe[1]);
        }
    }

    const tieneSusIntentosFinalizado = (
        (textoLower.includes('sus intentos') || /intento\s+1/i.test(textoPlano) || textoLower.includes('resumen de sus intentos')) &&
        (/estado\s*finalizado/i.test(textoPlano) || /estado\s*terminado/i.test(textoPlano) || textoLower.includes('completado'))
    );

    const tieneChapitaCalificado = (
        textoLower.includes('hecho: recibir una calificaci') ||
        textoLower.includes('hecho: alcanzar la calificaci') ||
        textoLower.includes('hecho: hacer un env') ||
        textoLower.includes('hecho: realizar un intento')
    );

    const tieneTareaEntregada = (
        textoLower.includes('enviado para calificar') ||
        (textoLower.includes('estado de la entrega') && textoLower.includes('enviado'))
    );

    if (notaNum !== null || tieneSusIntentosFinalizado || tieneChapitaCalificado || tieneTareaEntregada) {
        return { realizada: true, nota: formatearNota(notaNum), notaNum };
    }

    return { realizada: false, nota: null, notaNum: null };
}

function crearSesionMoodle() {
    const cookiesMap = { MoodleTestSession: 'enabled' };

    const guardarCookies = (headers) => {
        if (!headers || !headers['set-cookie']) return;
        const lista = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
        for (const c of lista) {
            const par = c.split(';')[0];
            const eqIdx = par.indexOf('=');
            if (eqIdx > 0) {
                const nombre = par.substring(0, eqIdx).trim();
                const valor = par.substring(eqIdx + 1).trim();
                if (valor && valor !== 'deleted') cookiesMap[nombre] = valor;
            }
        }
    };

    const obtenerHeaderCookie = () => Object.entries(cookiesMap).map(([k, v]) => `${k}=${v}`).join('; ');

    const get = async (url, redireccionesRestantes = 8) => {
        const resp = await axios.get(url, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            timeout: 25000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'es-AR,es;q=0.9',
                'Cookie': obtenerHeaderCookie()
            }
        });
        guardarCookies(resp.headers);

        if (resp.status >= 300 && resp.status < 400 && resp.headers.location && redireccionesRestantes > 0) {
            const nextUrl = new URL(resp.headers.location, url).toString();
            return await get(nextUrl, redireccionesRestantes - 1);
        }
        return resp;
    };

    const intentarCredenciales = async (userStr, passStr) => {
        const getResp = await get(URL_LOGIN);
        const $login = cheerio.load(getResp.data);
        const logintoken = $login('input[name="logintoken"]').val() || '';

        const formParams = new URLSearchParams();
        formParams.append('anchor', '');
        if (logintoken) formParams.append('logintoken', logintoken);
        formParams.append('username', userStr);
        formParams.append('password', passStr);

        const postResp = await axios.post(URL_LOGIN, formParams.toString(), {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            timeout: 25000,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Cookie': obtenerHeaderCookie(),
                'Origin': 'https://9002.edusalta.gov.ar',
                'Referer': URL_LOGIN
            }
        });
        guardarCookies(postResp.headers);

        let paginaFinal = postResp;
        if (postResp.status >= 300 && postResp.status < 400 && postResp.headers.location) {
            const redirectUrl = new URL(postResp.headers.location, URL_LOGIN).toString();
            paginaFinal = await get(redirectUrl);
        }

        const htmlFinal = String(paginaFinal.data || '');
        const $final = cheerio.load(htmlFinal);
        const tieneLogout = htmlFinal.includes('login/logout.php') || $final('a[href*="logout.php"]').length > 0;
        const noTieneInputPass = $final('input[name="password"]').length === 0;

        return tieneLogout || noTieneInputPass;
    };

    const postLogin = async (dniRaw, passRaw) => {
        const dniLimpio = String(dniRaw || '').replace(/\./g, '').trim();
        const passLimpia = String(passRaw || '').trim();

        if (await intentarCredenciales(dniLimpio, passLimpia)) return { ok: true };
        if (passLimpia.replace(/\./g, '') !== passLimpia) {
            if (await intentarCredenciales(dniLimpio, passLimpia.replace(/\./g, ''))) return { ok: true };
        }
        if (passLimpia !== dniLimpio) {
            if (await intentarCredenciales(dniLimpio, dniLimpio)) return { ok: true };
        }
        return { ok: false };
    };

    return { get, postLogin };
}

// Genera el texto de resumen unificando el seguimiento normal + las Evaluaciones con nota (6 o más = Aprobado, <6 = Desaprobado -> S15)
function construirResumenTextoAlumno(nombreAlumno, datosSemanas) {
    let detallesTexto = [];

    // 1. Semanas regulares de cursada (S02 a S12): solo importa si están hechas o faltan
    for (const sem of SEMANAS_CURSADA) {
        if (!datosSemanas[sem]) continue;
        datosSemanas[sem].faltan = (datosSemanas[sem].faltan || []).filter(
            f => !(datosSemanas[sem].completas || []).some(c => mismaMateria(c, f))
        );

        const cComp = (datosSemanas[sem].completas || []).length;
        const cFalt = (datosSemanas[sem].faltan || []).length;
        if (cComp > 0 || cFalt > 0) {
            const etiqueta = `Semana ${sem.replace('S0', '').replace('S', '')}`;
            let estado = "";
            if (cFalt === 0) estado = "COMPLETA";
            else if (cComp === 0) estado = "No realizó nada";
            else estado = `Falta realizar ${datosSemanas[sem].faltan.join(', ').toLowerCase()}`;
            detallesTexto.push(`${etiqueta}: ${estado}`);
        }
    }

    // 2. Evaluaciones (con Nota y estado Aprobado / Desaprobado -> Recuperatorio S15)
    if (datosSemanas["Evaluaciones"]) {
        const ev = datosSemanas["Evaluaciones"];
        const detalleEval = ev.detalle_notas || {};
        const partesEval = [];

        const materiasOrden = ['Matemática', 'Lengua', 'Cs. Sociales', 'Cs. Naturales', 'FpT'];
        for (const mat of materiasOrden) {
            if (detalleEval[mat]) {
                const info = detalleEval[mat];
                if (info.realizada && info.nota !== null) {
                    const cond = info.aprobada ? 'Aprobado' : 'Desaprobado -> Recup. S15';
                    partesEval.push(`Evaluación ${mat} ${info.nota} (${cond})`);
                } else if (info.realizada) {
                    partesEval.push(`Evaluación ${mat} (Realizada)`);
                } else {
                    partesEval.push(`Evaluación ${mat}: Sin rendir (A Recup. S15)`);
                }
            }
        }

        if (partesEval.length > 0) {
            detallesTexto.push(`EVALUACIONES: ${partesEval.join(' | ')}`);
        } else {
            const cComp = (ev.completas || []).length;
            const cFalt = (ev.faltan || []).length;
            if (cComp > 0 || cFalt > 0) {
                const todas = [...(ev.completas || []), ...(ev.faltan || [])];
                detallesTexto.push(`EVALUACIONES: ${todas.join(', ')}`);
            }
        }
    }

    // 3. Recuperatorios Semana 15 (S15_Recup)
    if (datosSemanas["S15_Recup"]) {
        const rec = datosSemanas["S15_Recup"];
        const detalleRec = rec.detalle_notas || {};
        const partesRec = [];

        for (const [mat, info] of Object.entries(detalleRec)) {
            if (info.realizada && info.nota !== null) {
                const cond = info.aprobada ? 'Aprobado en S15' : 'Desaprobado en S15';
                partesRec.push(`Recup. ${mat} ${info.nota} (${cond})`);
            } else if (info.realizada) {
                partesRec.push(`Recup. ${mat} (Rindió)`);
            }
        }
        if (partesRec.length > 0) {
            detallesTexto.push(`RECUPERATORIO S15: ${partesRec.join(' | ')}`);
        }
    }

    return detallesTexto.length > 0
        ? `${nombreAlumno.toUpperCase()}: ${detallesTexto.join(' - ')}`
        : `${nombreAlumno.toUpperCase()}: Sin registros`;
}

async function ejecutarScrapingMoodle(sede, modulo, orientacion, anio, periodo, cursadaIds, soloEvaluaciones = false) {
    const modoTexto = soloEvaluaciones ? 'Solo Evaluaciones' : 'Completo';
    estadoBot = { ejecutando: true, progreso: `Preparando seguimiento (${modoTexto}) en ${sede}...`, procesados: 0, total: 0 };

    try {
        let query = `
            SELECT a.dni, a.contrasena_moodle, a.nombre_completo, c.id as cursada_id, c.seguimiento_semanal
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

        const resAct = await pool.query(
            `SELECT * FROM actividades_moodle WHERE numero_modulo = $1 AND orientacion = $2 AND activa = TRUE ORDER BY semana ASC, materia ASC`,
            [modulo, orientacion]
        );
        // Si pidió "Solo Evaluaciones", filtramos únicamente los enlaces de Evaluaciones y S15_Recup
        const todasActividades = resAct.rows;
        const actividadesAEscanear = soloEvaluaciones
            ? todasActividades.filter(a => SEMANAS_EXAMENES.includes(a.semana))
            : todasActividades;

        const resConf = await pool.query(`SELECT url_calificaciones FROM config_cursos_moodle WHERE numero_modulo = $1 AND orientacion = $2`, [modulo, orientacion]);
        let urlCalificacionesConfigurada = resConf.rows[0]?.url_calificaciones || '';

        for (let i = 0; i < alumnos.length; i++) {
            if (!estadoBot.ejecutando) break;
            const al = alumnos[i];
            estadoBot.progreso = `[${sede} - ${modoTexto}] (${i + 1}/${alumnos.length}): ${al.nombre_completo}`;
            estadoBot.procesados = i + 1;

            try {
                const sesion = crearSesionMoodle();
                const loginRes = await sesion.postLogin(al.dni, al.contrasena_moodle);

                if (!loginRes.ok) {
                    const msgError = `${al.nombre_completo.toUpperCase()}: ⚠️ Usuario o contraseña de Moodle incorrectos (DNI: ${al.dni})`;
                    await pool.query(
                        `UPDATE cursadas_modulos SET resumen_texto = $1, ultima_actualizacion_bot = CURRENT_TIMESTAMP WHERE id = $2`,
                        [msgError, al.cursada_id]
                    );
                    continue;
                }

                // Si es "Solo Evaluaciones", partimos del JSON que ya tenía el alumno para NO borrarle las semanas S02 a S12
                let datosSemanas = {};
                if (soloEvaluaciones && al.seguimiento_semanal) {
                    datosSemanas = typeof al.seguimiento_semanal === 'string'
                        ? JSON.parse(al.seguimiento_semanal)
                        : al.seguimiento_semanal;
                }

                SEMANAS_ORDEN.forEach(s => {
                    if (!datosSemanas[s] || !soloEvaluaciones || SEMANAS_EXAMENES.includes(s)) {
                        datosSemanas[s] = { completas: [], faltan: [], detalle_notas: {} };
                    }
                });

                const estadoPorIdEnTabla = {};
                let courseIdDetectado = null;
                const resultadosDirectosPorActividad = {};

                // PASO 1: Visitar los enlaces directos que correspondan (todos o solo Evaluaciones/S15)
                for (const act of actividadesAEscanear) {
                    const urlAct = act.url_actividad ? act.url_actividad.trim() : '';
                    if (!urlAct || urlAct === 'Revisión_Manual') continue;

                    try {
                        const respAct = await sesion.get(urlAct);
                        const htmlAct = String(respAct.data || '');

                        if (!courseIdDetectado) {
                            const matchCourse = htmlAct.match(/course\/view\.php\?id=(\d+)/) || htmlAct.match(/grade\/report\/user\/index\.php\?id=(\d+)/);
                            if (matchCourse) courseIdDetectado = matchCourse[1];
                        }

                        resultadosDirectosPorActividad[act.id] = analizarPaginaActividadMoodle(htmlAct);
                    } catch (errLink) {
                        resultadosDirectosPorActividad[act.id] = { realizada: false, nota: null, notaNum: null };
                    }
                }

                // PASO 2: Leer la Tabla General de Calificaciones (Doble verificación)
                let urlTablaEfectiva = urlCalificacionesConfigurada;
                if (!urlTablaEfectiva && courseIdDetectado) {
                    urlTablaEfectiva = `https://9002.edusalta.gov.ar/grade/report/user/index.php?id=${courseIdDetectado}`;
                }

                if (urlTablaEfectiva) {
                    try {
                        const getGrades = await sesion.get(urlTablaEfectiva);
                        const $grades = cheerio.load(getGrades.data);

                        $grades('tr').each((_, el) => {
                            const evalFila = evaluarFilaTablaCalificaciones($grades, el);

                            $grades(el).find('a[href*="id="]').each((__, aTag) => {
                                const href = $grades(aTag).attr('href') || '';
                                const idMod = extraerIdModuloUrl(href);
                                if (idMod && evalFila.realizada) {
                                    estadoPorIdEnTabla[idMod] = evalFila;
                                }
                            });

                            const textoFila = $grades(el).text().replace(/\s+/g, ' ').trim();
                            const semEncontrada = detectarSemanaEnTexto(textoFila);
                            const materiaLimpia = extraerMateriaLimpia(textoFila);

                            if (semEncontrada && materiaLimpia) {
                                // Si estamos en modo "Solo Evaluaciones", ignoramos semanas S02..S12 de la tabla
                                if (soloEvaluaciones && !SEMANAS_EXAMENES.includes(semEncontrada)) return;

                                const esExamen = SEMANAS_EXAMENES.includes(semEncontrada);
                                if (esExamen) {
                                    if (!datosSemanas[semEncontrada].detalle_notas) datosSemanas[semEncontrada].detalle_notas = {};
                                    if (evalFila.realizada) {
                                        const nNum = evalFila.notaNum;
                                        const aprobada = nNum !== null ? nNum >= 6.0 : true;
                                        datosSemanas[semEncontrada].detalle_notas[materiaLimpia] = {
                                            realizada: true,
                                            nota: evalFila.nota,
                                            notaNum: nNum,
                                            aprobada
                                        };
                                    }
                                } else {
                                    if (evalFila.realizada) {
                                        const etiq = evalFila.nota ? `${materiaLimpia} (${evalFila.nota})` : materiaLimpia;
                                        if (!datosSemanas[semEncontrada].completas.some(m => mismaMateria(m, materiaLimpia))) {
                                            datosSemanas[semEncontrada].completas.push(etiq);
                                        }
                                        datosSemanas[semEncontrada].faltan = datosSemanas[semEncontrada].faltan.filter(m => !mismaMateria(m, materiaLimpia));
                                    } else {
                                        if (!datosSemanas[semEncontrada].faltan.some(m => mismaMateria(m, materiaLimpia)) &&
                                            !datosSemanas[semEncontrada].completas.some(m => mismaMateria(m, materiaLimpia))) {
                                            datosSemanas[semEncontrada].faltan.push(materiaLimpia);
                                        }
                                    }
                                }
                            }
                        });
                    } catch (eGrades) {
                        console.error('Error leyendo tabla general:', eGrades.message);
                    }
                }

                // PASO 3: Combinar ambas verificaciones y aplicar la regla especial para Evaluaciones y Semana 15 (Nota >= 6 Aprobado, < 6 Recuperatorio)
                for (const act of actividadesAEscanear) {
                    const sem = act.semana;
                    const mat = act.materia;
                    const urlAct = act.url_actividad ? act.url_actividad.trim() : '';

                    if (!datosSemanas[sem] || !urlAct) continue;

                    const esExamen = SEMANAS_EXAMENES.includes(sem);

                    if (urlAct === 'Revisión_Manual') {
                        datosSemanas[sem].completas = datosSemanas[sem].completas.filter(m => !mismaMateria(m, mat));
                        datosSemanas[sem].faltan = datosSemanas[sem].faltan.filter(m => !mismaMateria(m, mat));
                        datosSemanas[sem].completas.push(`${mat} (Colaborativa)`);
                        continue;
                    }

                    const idLink = extraerIdModuloUrl(urlAct);
                    const infoTablaId = idLink ? estadoPorIdEnTabla[idLink] : null;
                    const dioPositivoEnTablaPorId = Boolean(infoTablaId?.realizada);
                    const dioPositivoEnTablaPorNombre = datosSemanas[sem].completas.some(m => mismaMateria(m, mat)) ||
                        Boolean(datosSemanas[sem].detalle_notas?.[mat]?.realizada);
                    const resultadoDirecto = resultadosDirectosPorActividad[act.id] || { realizada: false, nota: null, notaNum: null };

                    const estaRealizada = resultadoDirecto.realizada || dioPositivoEnTablaPorId || dioPositivoEnTablaPorNombre;
                    const notaNumFinal = resultadoDirecto.notaNum ?? infoTablaId?.notaNum ?? datosSemanas[sem].detalle_notas?.[mat]?.notaNum ?? null;
                    const notaStrFinal = resultadoDirecto.nota || infoTablaId?.nota || datosSemanas[sem].detalle_notas?.[mat]?.nota || null;

                    datosSemanas[sem].completas = datosSemanas[sem].completas.filter(m => !mismaMateria(m, mat));
                    datosSemanas[sem].faltan = datosSemanas[sem].faltan.filter(m => !mismaMateria(m, mat));

                    if (esExamen) {
                        if (!datosSemanas[sem].detalle_notas) datosSemanas[sem].detalle_notas = {};

                        if (estaRealizada) {
                            // REGLA DE EVALUACIONES: 6.00 o más = Aprobado | Menos de 6.00 = Desaprobado (Va a Recuperatorio S15)
                            const aprobada = notaNumFinal !== null ? notaNumFinal >= 6.0 : true;
                            const estadoTexto = aprobada ? 'Aprobado' : 'Desaprobado';
                            const etiquetaEval = notaStrFinal
                                ? `${mat} ${notaStrFinal} (${estadoTexto})`
                                : `${mat} (Realizada)`;

                            datosSemanas[sem].detalle_notas[mat] = {
                                realizada: true,
                                nota: notaStrFinal,
                                notaNum: notaNumFinal,
                                aprobada
                            };

                            if (aprobada) {
                                datosSemanas[sem].completas.push(etiquetaEval);
                            } else {
                                // Si sacó menos de 6, queda registrada su nota pero figura como pendiente de recuperar en S15
                                datosSemanas[sem].faltan.push(etiquetaEval);
                            }
                        } else {
                            datosSemanas[sem].detalle_notas[mat] = {
                                realizada: false,
                                nota: null,
                                notaNum: null,
                                aprobada: false
                            };
                            datosSemanas[sem].faltan.push(`${mat} (Sin rendir)`);
                        }
                    } else {
                        // SEMANAS REGULARES (S02 a S12): Solo importa si está realizada o no
                        if (estaRealizada) {
                            const etiquetaConNota = notaStrFinal ? `${mat} (${notaStrFinal})` : mat;
                            datosSemanas[sem].completas.push(etiquetaConNota);
                        } else {
                            datosSemanas[sem].faltan.push(mat);
                        }
                    }
                }

                // PASO 4: Construir el resumen y guardar en Neon
                const resumenFinal = construirResumenTextoAlumno(al.nombre_completo, datosSemanas);

                await pool.query(
                    `UPDATE cursadas_modulos SET seguimiento_semanal = $1::jsonb, resumen_texto = $2, ultima_actualizacion_bot = CURRENT_TIMESTAMP WHERE id = $3`,
                    [JSON.stringify(datosSemanas), resumenFinal, al.cursada_id]
                );
            } catch (errAl) {
                console.error(`Error con ${al.nombre_completo}:`, errAl.message);
            }
        }
        estadoBot = { ejecutando: false, progreso: `¡Seguimiento (${modoTexto}) de ${sede} completado!`, procesados: alumnos.length, total: alumnos.length };
    } catch (errGral) {
        console.error(errGral);
        estadoBot = { ejecutando: false, progreso: 'Error al ejecutar el bot', procesados: 0, total: 0 };
    }
}

app.put('/api/seguimiento', async (req, res) => {
    try {
        const { cursada_id, seguimiento_json, resumen_texto } = req.body;
        await pool.query(
            `UPDATE cursadas_modulos SET seguimiento_semanal = $1::jsonb, resumen_texto = $2, ultima_actualizacion_bot = CURRENT_TIMESTAMP WHERE id = $3`,
            [JSON.stringify(seguimiento_json), resumen_texto, cursada_id]
        );
        res.json({ mensaje: 'Seguimiento actualizado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar seguimiento' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor API corriendo en el puerto ${PORT}`));
