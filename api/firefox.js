export default async function handler(req, res) {
    // Thêm CORS headers để cho phép gọi từ bất kỳ domain nào (Firebase Hosting, Localhost...)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // Xử lý preflight request của trình duyệt
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        // Trích xuất toàn bộ query string (ví dụ: act=getItem&key=)
        const urlParams = new URLSearchParams(req.query);
        
        // Dùng biến môi trường thay vì hardcode
        urlParams.set('token', process.env.FIREFOX_TOKEN || '');
        
        // Đổi sang HTTPS để mã hoá đường truyền
        const targetUrl = `https://www.firefox.fun/yhapi.ashx?${urlParams.toString()}`;

        // Bound upstream latency so one stuck request cannot delay OTP polling indefinitely.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        let response;
        let data;
        try {
            response = await fetch(targetUrl, {
                signal: controller.signal,
                cache: 'no-store',
                headers: { Accept: 'text/plain' }
            });
            data = await response.text();
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            res.status(response.status).send(data || `Firefox API HTTP ${response.status}`);
            return;
        }

        // Trả kết quả về cho Frontend
        res.status(200).send(data);
    } catch (error) {
        console.error('Vercel Proxy Error:', error);
        const status = error.name === 'AbortError' ? 504 : 500;
        res.status(status).json({ error: error.name === 'AbortError' ? 'Firefox API timeout' : 'Failed to fetch from Firefox API' });
    }
}
