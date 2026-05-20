-- =============================================================================
-- shift-block-runner: stub support
-- =============================================================================
-- - Adds a placeholder TEXT_REQUEST_STUB provider so demo runs are easy to
--   distinguish from real sends in notifications.
-- - Seeds message_templates with placeholder copy (en + es) for both
--   notification types so the runner has something to send. Replace these
--   rows with the real copy pulled from Text Request before going live.
-- =============================================================================

ALTER TABLE public.notifications
    DROP CONSTRAINT notifications_provider_check;
ALTER TABLE public.notifications
    ADD CONSTRAINT notifications_provider_check
    CHECK (provider IN ('TEXT_REQUEST','TEXT_REQUEST_STUB','TWILIO','EMAIL_SMTP'));

COMMENT ON COLUMN public.notifications.provider IS
    'Send channel. TEXT_REQUEST is the live channel; TEXT_REQUEST_STUB is the dry-run channel used until API credentials are wired up.';

-- Placeholder bodies. These are intentionally generic and SHOULD be replaced
-- before go-live with the exact text already in use in Text Request.
INSERT INTO public.message_templates (notification_type, language, body) VALUES
    ('END_OF_SHIFT_WARNING',     'en', 'Prestige: Your shift ends soon. Please complete your work and clock out on time. Reply STOP to opt out.'),
    ('END_OF_SHIFT_WARNING',     'es', 'Prestige: Su turno termina pronto. Por favor termine su trabajo y marque su salida a tiempo. Responda STOP para no recibir mensajes.'),
    ('END_OF_SHIFT_CLOCKED_OUT', 'en', 'Prestige: Your scheduled shift has ended. You have been clocked out. Contact your supervisor with questions. Reply STOP to opt out.'),
    ('END_OF_SHIFT_CLOCKED_OUT', 'es', 'Prestige: Su turno programado ha terminado. Se ha registrado su salida. Contacte a su supervisor si tiene preguntas. Responda STOP para no recibir mensajes.');
