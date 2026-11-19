def unicode_resources(ui, strings):
    """Give initial Text cells stable Unicode StringIds."""
    counter = [0]

    def visit(obj):
        if isinstance(obj, dict):
            value = obj.get('value')
            if obj.get('type') == 'Text' and isinstance(value, str) and value:
                sid = 'SID_TEXT_STATIC_%04d' % counter[0]
                counter[0] += 1
                strings[sid] = value
                obj.update(value=sid, type='StringId')
            else:
                for item in obj.values():
                    visit(item)
        elif isinstance(obj, list):
            for item in obj:
                visit(item)

    visit(ui)
    for n in range(256):
        strings['SID_TEXT_DYNAMIC_%04d' % n] = ''
    if len(strings) > 1024:
        raise ValueError('HMI string bundle exceeds the verified 1024-resource budget')
