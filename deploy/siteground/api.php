<?php
$config = require __DIR__ . '/config.php';
$dbPath = __DIR__ . '/data/db.json';
$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = preg_replace('#^/api#', '', $path);

route($method, $path, $config, $dbPath);

function route($method, $path, $config, $dbPath) {
    if ($method === 'GET' && $path === '/health') json(200, ['ok' => true]);

    if ($method === 'POST' && $path === '/auth/request') {
        $body = body();
        $email = normalize_email($body['email'] ?? '');
        if (!$email) json(400, ['error' => 'Email no válido']);

        $verification = verify_access($email, $config);
        if (!$verification['allowed']) json(403, ['error' => $verification['reason']]);

        $db = read_db($dbPath);
        upsert_profile($db, $email, $verification['name'] ?? '');
        $token = random_token();
        $db['magicLinks'] = array_values(array_filter($db['magicLinks'], fn($l) => $l['email'] !== $email));
        $db['magicLinks'][] = [
            'email' => $email,
            'tokenHash' => hash_token($token, $config),
            'expiresAt' => gmdate('c', time() + 15 * 60),
            'createdAt' => gmdate('c'),
        ];
        write_db($dbPath, $db);

        $magicUrl = rtrim($config['app_base_url'], '/') . '/api/auth/consume?token=' . rawurlencode($token);
        $sent = send_magic_link($email, $magicUrl, $config);
        if (!$sent) error_log("Enlace mágico para $email: $magicUrl");
        json(200, [
            'ok' => true,
            'message' => $sent
                ? 'Si el email está autorizado, recibirás un enlace de acceso.'
                : 'No se pudo enviar el email de acceso. Revisa la configuración de Resend.',
        ]);
    }

    if ($method === 'GET' && $path === '/auth/consume') {
        $token = $_GET['token'] ?? '';
        $db = read_db($dbPath);
        $hash = hash_token($token, $config);
        $link = null;
        foreach ($db['magicLinks'] as $item) {
            if ($item['tokenHash'] === $hash) $link = $item;
        }
        if (!$link || strtotime($link['expiresAt']) < time()) redirect('/');

        $db['magicLinks'] = array_values(array_filter($db['magicLinks'], fn($l) => $l['tokenHash'] !== $hash));
        $session = random_token();
        $db['sessions'][] = [
            'tokenHash' => hash_token($session, $config),
            'email' => $link['email'],
            'expiresAt' => gmdate('c', time() + 30 * 24 * 60 * 60),
            'createdAt' => gmdate('c'),
        ];
        write_db($dbPath, $db);
        set_session_cookie($session, $config);
        redirect('/app');
    }

    if ($method === 'POST' && $path === '/auth/logout') {
        $session = session_user($dbPath, $config);
        if ($session) {
            $db = read_db($dbPath);
            $db['sessions'] = array_values(array_filter($db['sessions'], fn($s) => $s['tokenHash'] !== $session['tokenHash']));
            write_db($dbPath, $db);
        }
        clear_session_cookie($config);
        json(200, ['ok' => true]);
    }

    $session = require_session($dbPath, $config);
    $email = $session['email'];

    if ($method === 'GET' && $path === '/me') json(200, ['user' => public_user($email, $config)]);
    if ($method === 'GET' && $path === '/data') json(200, member_data(read_db($dbPath), $email, $config));

    if ($method === 'PUT' && $path === '/me/profile') {
        $body = body();
        $db = read_db($dbPath);
        $profile =& upsert_profile($db, $email);
        $profile['name'] = clean($body['name'] ?? '', 90);
        $profile['voice'] = clean($body['voice'] ?? '', 40);
        write_db($dbPath, $db);
        json(200, ['profile' => $profile]);
    }

    if ($method === 'PUT' && preg_match('#^/attendance/([^/]+)$#', $path, $m)) {
        $eventId = rawurldecode($m[1]);
        $body = body();
        $db = read_db($dbPath);
        if (!array_filter($db['events'], fn($e) => $e['id'] === $eventId)) json(404, ['error' => 'Evento no encontrado']);
        $status = in_array($body['status'] ?? '', ['coming', 'late', 'absent'], true) ? $body['status'] : 'coming';
        $note = clean($body['note'] ?? '', 240);
        $found = false;
        foreach ($db['attendance'] as &$item) {
            if ($item['eventId'] === $eventId && $item['email'] === $email) {
                $item['status'] = $status;
                $item['note'] = $note;
                $item['updatedAt'] = gmdate('c');
                $found = true;
            }
        }
        if (!$found) {
            $db['attendance'][] = ['id' => random_token(9), 'eventId' => $eventId, 'email' => $email, 'status' => $status, 'note' => $note, 'updatedAt' => gmdate('c')];
        }
        write_db($dbPath, $db);
        json(200, member_data($db, $email, $config));
    }

    if (!is_admin($email, $config)) json(403, ['error' => 'Sólo admin']);

    if ($method === 'GET' && $path === '/admin') json(200, admin_data(read_db($dbPath), $config));

    if (($method === 'PUT' || $method === 'POST') && $path === '/admin/program') {
        $body = body();
        $db = read_db($dbPath);
        $idx = active_program_index($db);
        $db['programs'][$idx]['name'] = clean($body['name'] ?? '', 120) ?: $db['programs'][$idx]['name'];
        $db['programs'][$idx]['description'] = clean($body['description'] ?? '', 500);
        $db['programs'][$idx]['works'] = clean($body['works'] ?? '', 5000);
        $db['programs'][$idx]['scoreFolderUrl'] = clean($body['scoreFolderUrl'] ?? '', 700) ?: default_score_folder();
        $db['programs'][$idx]['playlists'] = clean_playlists($body);
        $db['programs'][$idx]['updatedAt'] = gmdate('c');
        write_db($dbPath, $db);
        json(200, admin_data($db, $config));
    }

    if ($method === 'POST' && $path === '/admin/program/reset') {
        $body = body();
        $db = read_db($dbPath);
        $programId = active_program($db)['id'] ?? 'programa-actual';
        $db['programs'] = [[
            'id' => $programId,
            'name' => clean($body['name'] ?? '', 120) ?: 'Nuevo programa',
            'description' => clean($body['description'] ?? '', 500),
            'works' => '',
            'scoreFolderUrl' => default_score_folder(),
            'playlists' => clean_playlists([]),
            'active' => true,
            'createdAt' => gmdate('c'),
        ]];
        $db['events'] = [];
        $db['resources'] = [[
            'id' => 'carpeta-partituras',
            'programId' => $programId,
            'title' => 'Carpeta de partituras',
            'type' => 'partituras',
            'url' => default_score_folder(),
            'notes' => 'Carpeta fija de partituras.',
            'createdAt' => gmdate('c'),
        ]];
        $db['attendance'] = [];
        write_db($dbPath, $db);
        json(200, admin_data($db, $config));
    }

    if ($method === 'POST' && $path === '/admin/events') {
        $body = body();
        $db = read_db($dbPath);
        $db['events'][] = [
            'id' => slug_id(($body['date'] ?? 'evento') . '-' . ($body['title'] ?? 'evento')),
            'programId' => $body['programId'] ?? active_program($db)['id'],
            'title' => clean($body['title'] ?? '', 120) ?: 'Evento',
            'type' => in_array($body['type'] ?? '', ['ensayo', 'concierto', 'otro'], true) ? $body['type'] : 'ensayo',
            'date' => $body['date'] ?? gmdate('Y-m-d'),
            'time' => clean($body['time'] ?? '', 40),
            'location' => clean($body['location'] ?? '', 160),
            'notes' => clean($body['notes'] ?? '', 500),
            'createdAt' => gmdate('c'),
        ];
        write_db($dbPath, $db);
        json(200, admin_data($db, $config));
    }

    if ($method === 'PUT' && preg_match('#^/admin/events/([^/]+)$#', $path, $m)) {
        $eventId = rawurldecode($m[1]);
        $body = body();
        $db = read_db($dbPath);
        foreach ($db['events'] as &$event) {
            if ($event['id'] === $eventId) {
                $event['title'] = clean($body['title'] ?? '', 120) ?: $event['title'];
                $event['type'] = in_array($body['type'] ?? '', ['ensayo', 'concierto', 'otro'], true) ? $body['type'] : $event['type'];
                $event['date'] = clean($body['date'] ?? '', 16) ?: $event['date'];
                $event['time'] = clean($body['time'] ?? '', 40);
                $event['location'] = clean($body['location'] ?? '', 160);
                $event['notes'] = clean($body['notes'] ?? '', 700);
                $event['updatedAt'] = gmdate('c');
                write_db($dbPath, $db);
                json(200, admin_data($db, $config));
            }
        }
        json(404, ['error' => 'Evento no encontrado']);
    }

    if ($method === 'POST' && $path === '/admin/resources') {
        $body = body();
        $db = read_db($dbPath);
        $db['resources'][] = [
            'id' => slug_id(($body['type'] ?? 'recurso') . '-' . ($body['title'] ?? 'recurso')),
            'programId' => $body['programId'] ?? active_program($db)['id'],
            'title' => clean($body['title'] ?? '', 120) ?: 'Recurso',
            'type' => clean($body['type'] ?? '', 40) ?: 'enlace',
            'url' => clean($body['url'] ?? '', 500),
            'notes' => clean($body['notes'] ?? '', 300),
            'createdAt' => gmdate('c'),
        ];
        write_db($dbPath, $db);
        json(200, admin_data($db, $config));
    }

    json(404, ['error' => 'Ruta no encontrada']);
}

function body() {
    $raw = file_get_contents('php://input');
    return $raw ? json_decode($raw, true) : [];
}

function read_db($path) {
    return json_decode(file_get_contents($path), true);
}

function write_db($path, $db) {
    $fp = fopen($path, 'c+');
    flock($fp, LOCK_EX);
    ftruncate($fp, 0);
    fwrite($fp, json_encode($db, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
}

function verify_access($email, $config) {
    if (is_admin($email, $config)) return ['allowed' => true, 'name' => explode('@', $email)[0]];
    $jwt = ghost_jwt($config['ghost_admin_api_key']);
    $filter = rawurlencode("email:'" . str_replace("'", "\\'", $email) . "'");
    $url = rtrim($config['ghost_api_url'], '/') . "/ghost/api/admin/members/?filter=$filter&include=labels&limit=1";
    $response = http_json($url, ['Authorization: Ghost ' . $jwt, 'Accept: application/json']);
    if ($response['status'] < 200 || $response['status'] >= 300) return ['allowed' => false, 'reason' => 'No se pudo validar el acceso con Ghost'];
    $member = $response['json']['members'][0] ?? null;
    if (!$member) return ['allowed' => false, 'reason' => 'Email no encontrado en Ghost'];
    foreach ($member['labels'] ?? [] as $label) {
        if (strtolower($label['name'] ?? '') === strtolower($config['ghost_access_label']) || strtolower($label['slug'] ?? '') === strtolower($config['ghost_access_label'])) {
            return ['allowed' => true, 'name' => $member['name'] ?? ''];
        }
    }
    return ['allowed' => false, 'reason' => 'Falta la etiqueta ' . $config['ghost_access_label']];
}

function send_magic_link($email, $magicUrl, $config) {
    $payload = [
        'from' => $config['mail_from'],
        'to' => $email,
        'subject' => 'Access to ' . ($config['app_name'] ?? 'Choir Private Area'),
        'html' => '<h1>' . htmlspecialchars($config['app_name'] ?? 'Choir Private Area') . '</h1><p>Use this link to enter the private choir area:</p><p><a href="' . htmlspecialchars($magicUrl) . '">Enter private area</a></p><p>This link expires in 15 minutes.</p>',
        'text' => "Enter " . ($config['app_name'] ?? 'Choir Private Area') . ": $magicUrl\n\nThis link expires in 15 minutes.",
    ];
    $ch = curl_init('https://api.resend.com/emails');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($payload),
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $config['resend_api_key'],
            'Content-Type: application/json',
        ],
        CURLOPT_RETURNTRANSFER => true,
    ]);
    curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return $status >= 200 && $status < 300;
}

function ghost_jwt($key) {
    [$kid, $secret] = explode(':', $key, 2);
    $now = time();
    $header = b64url(json_encode(['alg' => 'HS256', 'typ' => 'JWT', 'kid' => $kid]));
    $payload = b64url(json_encode(['iat' => $now, 'exp' => $now + 300, 'aud' => '/admin/']));
    $body = "$header.$payload";
    return $body . '.' . b64url(hash_hmac('sha256', $body, hex2bin($secret), true));
}

function http_json($url, $headers) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ['status' => $status, 'json' => json_decode($body, true)];
}

function session_user($dbPath, $config) {
    $token = session_cookie_value();
    if (!$token) return null;
    $db = read_db($dbPath);
    $hash = hash_token($token, $config);
    foreach ($db['sessions'] as $session) {
        if ($session['tokenHash'] === $hash && strtotime($session['expiresAt']) >= time()) return $session;
    }
    return null;
}

function require_session($dbPath, $config) {
    $session = session_user($dbPath, $config);
    if (!$session) json(401, ['error' => 'No autenticado']);
    return $session;
}

function member_data($db, $email, $config) {
    $program = active_program($db);
    $programId = $program['id'] ?? null;
    $events = array_values(array_filter($db['events'], fn($e) => $e['programId'] === $programId));
    usort($events, fn($a, $b) => strcmp(($a['date'] ?? '') . ($a['time'] ?? ''), ($b['date'] ?? '') . ($b['time'] ?? '')));
    return [
        'user' => public_user($email, $config),
        'program' => $program,
        'events' => $events,
        'resources' => array_values(array_filter($db['resources'], fn($r) => $r['programId'] === $programId)),
        'profile' => current(array_filter($db['profiles'], fn($p) => $p['email'] === $email)) ?: null,
        'attendance' => array_values(array_filter($db['attendance'], fn($a) => $a['email'] === $email)),
    ];
}

function admin_data($db, $config) {
    $data = member_data($db, '', $config);
    $data['programs'] = $db['programs'];
    $data['profiles'] = $db['profiles'];
    $data['allAttendance'] = $db['attendance'];
    return $data;
}

function &upsert_profile(&$db, $email, $name = '') {
    foreach ($db['profiles'] as &$profile) {
        if ($profile['email'] === $email) {
            if ($name && empty($profile['name'])) $profile['name'] = $name;
            return $profile;
        }
    }
    $db['profiles'][] = ['email' => $email, 'name' => $name, 'voice' => '', 'createdAt' => gmdate('c')];
    return $db['profiles'][count($db['profiles']) - 1];
}

function public_user($email, $config) {
    return ['email' => $email, 'role' => is_admin($email, $config) ? 'admin' : 'member', 'avatarUrl' => 'https://www.gravatar.com/avatar/' . md5(strtolower(trim($email))) . '?s=96&d=mp'];
}

function is_admin($email, $config) {
    return in_array(strtolower($email), array_map('strtolower', $config['admin_emails']), true);
}

function active_program($db) {
    foreach ($db['programs'] as $program) if (!empty($program['active'])) return $program;
    return $db['programs'][0] ?? null;
}

function active_program_index($db) {
    foreach ($db['programs'] as $i => $program) if (!empty($program['active'])) return $i;
    return 0;
}

function clean_playlists($value) {
    return ['appleMusic' => clean($value['appleMusic'] ?? '', 700), 'spotify' => clean($value['spotify'] ?? '', 700), 'youtube' => clean($value['youtube'] ?? '', 700)];
}

function default_score_folder() {
    return 'https://example.com/scores';
}

function set_session_cookie($value, $config) {
    $parts = [
        'ars_session=' . rawurlencode($value),
        'Expires=' . gmdate('D, d M Y H:i:s T', time() + 30 * 24 * 60 * 60),
        'Max-Age=' . (30 * 24 * 60 * 60),
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
    ];
    if (str_starts_with($config['app_base_url'], 'https://')) $parts[] = 'Secure';
    header('Set-Cookie: ' . implode('; ', $parts), false);
}

function clear_session_cookie($config) {
    $parts = [
        'ars_session=',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Max-Age=0',
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
    ];
    if (str_starts_with($config['app_base_url'], 'https://')) $parts[] = 'Secure';
    header('Set-Cookie: ' . implode('; ', $parts), false);
}

function session_cookie_value() {
    if (!empty($_COOKIE['ars_session'])) return $_COOKIE['ars_session'];
    $header = $_SERVER['HTTP_COOKIE'] ?? '';
    foreach (explode(';', $header) as $part) {
        $pieces = explode('=', trim($part), 2);
        if (count($pieces) === 2 && $pieces[0] === 'ars_session') return rawurldecode($pieces[1]);
    }
    return '';
}

function json($status, $payload) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function redirect($location) {
    header('Location: ' . $location, true, 302);
    exit;
}

function normalize_email($value) {
    $email = strtolower(trim($value));
    return filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : '';
}

function clean($value, $max) {
    $value = trim((string) $value);
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $max);
    }
    return substr($value, 0, $max);
}

function hash_token($token, $config) {
    return hash('sha256', $config['app_secret'] . ':' . $token);
}

function random_token($bytes = 24) {
    return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
}

function slug_id($value) {
    $base = strtolower(trim(preg_replace('/[^a-zA-Z0-9]+/', '-', iconv('UTF-8', 'ASCII//TRANSLIT', $value)), '-'));
    return ($base ?: 'item') . '-' . random_token(3);
}

function b64url($value) {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}
