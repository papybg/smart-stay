import asyncio
from antigravity import AntigravityEngine

# Инициализираме ядрото на Antigravity
ag = AntigravityEngine()

async def generate_lesson():
    """Агент 1: Генерира забавна езикова задача за детето във фонов режим"""
    print("\n[Агент Учител]: Мисля нова интересна задача...")
    
    prompt = (
        "Create a short, fun sentence in English for a 7-year-old child to translate into Bulgarian. "
        "Keep it simple, like 'The big dog runs' or 'I love apples'. Respond ONLY with the sentence."
    )
    # Използваме базовия модел gemini-flash-latest за бърза скорост
    response = await ag.models.gemini_flash_latest.generate(prompt)
    
    print(f"[Агент Учител] Готово! Нова задача за детето: \"{response.text.strip()}\"")
    return response.text.strip()

async def evaluate_answer(english_sentence, child_answer):
    """Агент 2: Анализира и оценява превода на детето паралелно"""
    print("\n[Агент Оценител]: Проверявам отговора на детето...")
    
    prompt = (
        f"The English sentence was: '{english_sentence}'. The child translated it as: '{child_answer}'. "
        f"Is the translation correct and natural in Bulgarian? Respond with a short, encouraging feedback "
        f"in English for the child, and a 1-sentence explanation if they made a mistake."
    )
    response = await ag.models.gemini_flash_latest.generate(prompt)
    
    print(f"[Агент Оценител] Резултат от проверката:\n{response.text.strip()}")
    return response.text.strip()

async def main():
    print("=== СТАРТИРАНЕ НА ИИ УЧИТЕЛ (ANTIGRAVITY SDK) ===")
    
    # 1. Генерираме първата задача
    current_lesson = await generate_lesson()
    
    # 2. Очакваме вход от потребителя (детето) в терминала
    print("\n--------------------------------------------------")
    child_input = input(f"Преведи на български: \"{current_lesson}\"\nТвоят отговор: ")
    print("--------------------------------------------------")
    
    # 3. Стартираме паралелните процеси чрез Antigravity:
    # Докато Агент Оценител проверява сегашния отговор, Агент Учител вече подготвя следващия урок!
    print("\n[Система] Пускаме двата агента да работят едновременно...")
    
    evaluation_task = asyncio.create_task(evaluate_answer(current_lesson, child_input))
    next_lesson_task = asyncio.create_task(generate_lesson())
    
    # Изчакваме паралелното изпълнение и на двата агента
    await asyncio.gather(evaluation_task, next_lesson_task)
    
    print("\n=== Сесията завърши успешно ===")

if __name__ == "__main__":
    asyncio.run(main())