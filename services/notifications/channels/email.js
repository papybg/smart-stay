import nodemailer from 'nodemailer';

let cachedTransporter = null;

function getTransporter() {
    if (cachedTransporter) return cachedTransporter;

    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
        throw new Error('SMTP credentials are missing');
    }

    cachedTransporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
    });

    return cachedTransporter;
}

export async function sendEmail({ to, subject, text, html }) {
    if (!to) {
        throw new Error('Email recipient is missing');
    }

    const transporter = getTransporter();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    return transporter.sendMail({
        from,
        to,
        subject,
        text,
        html
    });
}
