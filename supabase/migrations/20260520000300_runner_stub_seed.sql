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

-- English bodies sourced from REFERENCE: Labor Controls — All Phases (slide 3,
-- 12/03/2025). Spanish bodies are translations pending native-speaker review
-- before go-live; the reference deck only contained the English text.
INSERT INTO public.message_templates (notification_type, language, body) VALUES
    ('END_OF_SHIFT_WARNING', 'en',
     'Hello Prestige Employee, Reminder: Your shift will be ending soon. We ask that you complete your work and use the last 15 minutes of your scheduled shift to put your supplies and equipment away and clock out for the day. YOU ARE NOT authorized nor approved to work past the end of your shift. Failure to clock out at the end of your shift may result in disciplinary action up to and including termination. If there is a circumstance that we need to be aware of please call your Manager now.'),
    ('END_OF_SHIFT_WARNING', 'es',
     'Hola Empleado de Prestige, Recordatorio: Su turno terminará pronto. Le pedimos que complete su trabajo y use los últimos 15 minutos de su turno programado para guardar sus suministros y equipo y marcar su salida por hoy. USTED NO está autorizado ni aprobado para trabajar más allá del final de su turno. No marcar su salida al final de su turno puede resultar en acción disciplinaria hasta e incluyendo la terminación. Si hay una circunstancia de la que debamos estar al tanto, por favor llame a su Gerente ahora.'),
    ('END_OF_SHIFT_CLOCKED_OUT', 'en',
     'Hello Prestige Employee, Your shift has ended please STOP working. You are instructed to clock out for the day. If there is a circumstance that we need to be aware of please call your Manager now. Have a great day and we will see you on your next scheduled shift!'),
    ('END_OF_SHIFT_CLOCKED_OUT', 'es',
     'Hola Empleado de Prestige, Su turno ha terminado, por favor DEJE de trabajar. Se le indica que marque su salida por hoy. Si hay una circunstancia de la que debamos estar al tanto, por favor llame a su Gerente ahora. ¡Que tenga un excelente día y nos veremos en su próximo turno programado!');
