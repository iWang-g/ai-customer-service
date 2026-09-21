import unittest
import json
from unittest.mock import AsyncMock, patch
from app.pipeline import build_reply
from app.schemas import ReplyRequest
from app.qianniu_policy import (blocked_word, explicit_email_unavailable,
                                explicit_image_delivery_intent, explicit_image_request)
from test_pipeline import combined_json, intent_json


class QianniuPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_incoming_image_asks_for_text_without_vision_or_email_route(self):
        question='您想咨询图片里的哪方面，方便用文字说明一下吗？'
        with patch('app.pipeline.generate_with_provider',AsyncMock(return_value=(intent_json(
                'direct_reply',direct_reply_text=question,needs_clarification=True),'mock'))) as model, \
                patch('app.pipeline.match_qa',AsyncMock()) as qa:
            result=await build_reply(ReplyRequest(platform='qianniu',message='[图片]',allow_auto_send=True,
                qa_base_ids=['qa'],platform_context=[{'type':'qianniu_unread_image','data':{'vision_available':False}}]))
        self.assertEqual(result.decision,'auto_send'); self.assertEqual(result.text,question)
        self.assertEqual(result.action_plan.workflow,'clarify_request'); qa.assert_not_awaited()
        self.assertIn('没有识图能力',model.call_args.kwargs['system'])
        self.assertIn('收到图片不等于客户索要图片',model.call_args.kwargs['system'])
        self.assertIn('qianniu_unread_image',model.call_args.kwargs['user'])

    async def test_same_unread_image_after_clarification_can_request_human(self):
        previous='方便用文字说明一下需要处理的问题吗？'
        with patch('app.pipeline.generate_with_provider',AsyncMock(return_value=(intent_json(
                'human_handoff',reason='同一个问题澄清后仍无法读取图片'),'mock'))) as model:
            result=await build_reply(ReplyRequest(platform='qianniu',message='[图片]',
                conversation=[{'role':'assistant','content':previous}],
                platform_context=[{'type':'qianniu_unread_image','data':{'vision_available':False}}]))
        self.assertEqual(result.decision,'needs_human'); self.assertEqual(result.text,'')
        self.assertIn(previous,model.call_args.kwargs['user'])
        self.assertIn('同一个未解决问题只进行一次主要澄清',model.call_args.kwargs['system'])

    async def test_image_followup_text_can_answer_with_known_product_facts(self):
        with patch('app.pipeline.generate_with_provider',AsyncMock(return_value=(combined_json(
                '亲，这款有黄色可选。'),'mock'))) as model:
            result=await build_reply(ReplyRequest(platform='qianniu',message='有黄色吗',allow_auto_send=True,
                conversation=[{'role':'user','content':'[图片]'},
                    {'role':'assistant','content':'您想了解哪方面呢？'}],
                platform_context=[{'type':'qianniu_unread_image','data':{'vision_available':False}}],
                product_details=[{'title':'枕套','specifications':['黄色','蓝色']}]))
        self.assertEqual(result.decision,'auto_send'); self.assertIn('黄色',result.text)
        self.assertIn('不能描述画面',model.call_args.kwargs['system'])

    async def test_product_introduction_selects_candidates_without_generating_urls(self):
        body = '亲，义乳有不同类型，您想了解哪一种呢？'
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(combined_json(
                body, attach_product_links=True, selected_product_ids=['123', '999', '123', '456'],
        ), 'mock'))) as model, patch('app.pipeline.search_documents', AsyncMock(return_value=[
                {'snippet': '义乳有不同类型。'}])):
            result = await build_reply(ReplyRequest(platform='qianniu', message='义乳的相关介绍',
                allow_auto_send=True, product_base_ids=['kb'], product_link_candidates=[
                    {'product_id': '123', 'title': '义乳'}, {'product_id': '456', 'title': '义乳配件'}]))
        self.assertEqual(result.text, body)
        self.assertEqual(result.intent.selected_product_ids, ['123', '456'])
        self.assertTrue(result.intent.attach_product_links)
        self.assertEqual(model.await_count, 1)
        self.assertIn('义乳配件', model.call_args.kwargs['user'])
        self.assertIn('仅标题关键词相同不代表相关', model.call_args.kwargs['system'])

    async def test_product_links_are_optional_and_disabled_for_clarification(self):
        for overrides in [{'attach_product_links': False}, {'needs_clarification': True},
                          {'selected_product_ids': ['999']}, {'selected_product_ids': '123'}]:
            payload = {'attach_product_links': True, 'selected_product_ids': ['123'], **overrides}
            with self.subTest(overrides=overrides), patch('app.pipeline.generate_with_provider',
                    AsyncMock(return_value=(combined_json('亲，您指哪项呢？', **payload), 'mock'))):
                result = await build_reply(ReplyRequest(platform='qianniu', message='这个呢',
                    product_details=[{'title': '枕套'}], product_link_candidates=[
                        {'product_id': '123', 'title': '枕套'}]))
            self.assertFalse(result.intent.attach_product_links)
            self.assertEqual(result.intent.selected_product_ids, [])

    async def test_ambiguous_number_with_product_details_asks_in_one_call(self):
        question = '亲，您说的1是指哪种尺寸或配置呢？'
        provider = AsyncMock(return_value=(combined_json(
            question, needs_clarification=True, answerable=False,
            wants_product_recommendation=True, product_recommendation_query='抱枕',
        ), 'mock'))
        with patch('app.pipeline.generate_with_provider', provider):
            result = await build_reply(ReplyRequest(
                platform='qianniu', message='1', allow_auto_send=True,
                product_details=[{'product_id': '1065752861716', 'skus': [
                    {'specification': '50x150'}, {'specification': '50x160'}]}],
                conversation=[{'role': 'assistant', 'content': '您想要哪个尺寸和材质呢？'}],
            ))
        self.assertEqual(result.decision, 'auto_send')
        self.assertEqual(result.text, question)
        self.assertTrue(result.intent.needs_clarification)
        self.assertEqual(result.action_plan.workflow, 'clarify_request')
        self.assertFalse(result.action_plan.need_doc_search)
        self.assertFalse(result.intent.wants_product_recommendation)
        self.assertEqual(provider.await_count, 1)
        self.assertIn('没有编号选项', provider.call_args.kwargs['system'])
        self.assertIn('您想要哪个尺寸和材质呢', provider.call_args.kwargs['user'])

    async def test_intent_clarification_skips_qa_and_missing_knowledge_fallback(self):
        for message in ['1', '那个尺寸呢']:
            with self.subTest(message=message), \
                    patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent_json(
                        needs_clarification=True, direct_reply_text='亲，您具体指哪一种呢？',
                    ), 'mock'))) as provider, \
                    patch('app.pipeline.match_qa', AsyncMock()) as qa, \
                    patch('app.pipeline.search_documents', AsyncMock()) as search:
                result = await build_reply(ReplyRequest(
                    platform='qianniu', message=message, qa_base_ids=['qa'], allow_auto_send=True,
                ))
            self.assertEqual(result.decision, 'auto_send')
            self.assertEqual(result.action_plan.workflow, 'clarify_request')
            self.assertEqual(provider.await_count, 1)
            qa.assert_not_awaited()
            search.assert_not_awaited()

    async def test_generation_can_clarify_after_separate_intent(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[
                (intent_json(), 'mock'),
                (json.dumps({'answerable': False, 'needs_clarification': True,
                             'text': '亲，您具体想了解哪项服务呢？'}), 'mock'),
        ])):
            result = await build_reply(ReplyRequest(
                platform='qianniu', message='这个服务呢', allow_auto_send=True,
                conversation=[{'role': 'assistant', 'content': '您是想了解定制服务吗？'}],
                shop_product_summary={'shop_intro': '抱枕店铺'},
            ))
        self.assertEqual(result.decision, 'auto_send')
        self.assertEqual(result.action_plan.workflow, 'clarify_request')

    async def test_numbered_choice_ack_and_clarified_question_are_not_forced_to_clarify(self):
        cases = [
            ('1', '请选择：1是50x150，2是50x160。', '好的，您选择的是50x150。'),
            ('好的', '您选的是50x150。', '好的亲，有需要随时告诉我。'),
            ('50x150包含枕芯吗', '您具体指哪种配置呢？', '亲，这个配置是单枕套，不含枕芯。'),
        ]
        for message, previous, reply in cases:
            with self.subTest(message=message), patch('app.pipeline.generate_with_provider',
                    AsyncMock(return_value=(combined_json(reply, needs_clarification=False), 'mock'))):
                result = await build_reply(ReplyRequest(
                    platform='qianniu', message=message, allow_auto_send=True,
                    product_details=[{'skus': [{'specification': '50x150单枕套'}]}],
                    conversation=[{'role': 'assistant', 'content': previous}],
                ))
            self.assertEqual(result.decision, 'auto_send')
            self.assertEqual(result.text, reply)
            self.assertFalse(result.intent.needs_clarification)
            self.assertNotEqual(result.action_plan.workflow, 'clarify_request')

    async def test_handoff_and_email_routes_win_over_conflicting_clarification_flag(self):
        for intent, decision, workflow in [
            ('human_handoff', 'needs_human', 'human_review'),
            ('email_link_request', 'suggest', 'collect_email_for_link'),
        ]:
            with self.subTest(intent=intent), patch('app.pipeline.generate_with_provider',
                    AsyncMock(return_value=(combined_json(
                        '您指什么呢？', intent=intent, needs_clarification=True,
                    ), 'mock'))):
                result = await build_reply(ReplyRequest(
                    platform='qianniu', message='帮我办理一下', allow_auto_send=True,
                    product_details=[{'title': '枕套'}],
                ))
            self.assertEqual(result.decision, decision)
            self.assertEqual(result.action_plan.workflow, workflow)
            self.assertEqual(result.text, '')

    async def test_clarification_does_not_mask_missing_evidence_or_invalid_output(self):
        answers = [
            combined_json('', answerable=False, reason='缺少具体工期'),
            combined_json('', needs_clarification=True),
            combined_json(' ', needs_clarification=True),
            combined_json('', needs_clarification='true'),
            '无效协议输出',
        ]
        for answer in answers:
            with self.subTest(answer=answer), patch('app.pipeline.generate_with_provider',
                    AsyncMock(return_value=(answer, 'mock'))):
                result = await build_reply(ReplyRequest(
                    platform='qianniu', message='这个复杂图案多久完成？', allow_auto_send=True,
                    product_details=[{'title': '枕套'}],
                ))
            self.assertEqual(result.decision, 'needs_human')
            self.assertEqual(result.text, '')

    async def test_explicit_human_operation_is_not_changed_to_clarification(self):
        for message in ['转人工', '帮我修改收货地址']:
            with self.subTest(message=message), patch('app.pipeline.generate_with_provider',
                    AsyncMock(return_value=(intent_json(
                        'human_handoff', needs_clarification=True,
                        direct_reply_text='请再说一下呢？',
                    ), 'mock'))):
                result = await build_reply(ReplyRequest(platform='qianniu', message=message, allow_auto_send=True))
            self.assertEqual(result.decision, 'needs_human')
            self.assertEqual(result.action_plan.workflow, 'human_review')
            self.assertFalse(result.intent.needs_clarification)

    async def test_clarification_keeps_outbound_safety_and_auto_send_setting(self):
        for question, allow_send, expected in [
            ('亲，您指哪种配置呢？', False, 'suggest'),
            ('请打开https://example.com告诉我是哪款', True, 'auto_send'),
        ]:
            with self.subTest(question=question), patch('app.pipeline.generate_with_provider',
                    AsyncMock(return_value=(combined_json(question, needs_clarification=True), 'mock'))):
                result = await build_reply(ReplyRequest(
                    platform='qianniu', message='1', allow_auto_send=allow_send,
                    product_details=[{'title': '枕套'}],
                ))
            self.assertEqual(result.decision, expected)
            self.assertNotIn('https://', result.text)
            if allow_send:
                self.assertEqual(result.action_plan.workflow, 'fallback_reply')

    async def test_other_platform_does_not_use_qianniu_clarification_field(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent_json(
                'direct_reply', direct_reply_text='亲，您具体指哪项呢？', needs_clarification=True,
        ), 'mock'))):
            result = await build_reply(ReplyRequest(platform='wechat', message='1', allow_auto_send=True))
        self.assertEqual(result.action_plan.workflow, 'direct_reply')
        self.assertFalse(result.intent.needs_clarification)

    async def test_low_risk_product_question_uses_one_combined_model_call(self):
        provider = AsyncMock(return_value=(combined_json(
            '亲亲，这款通常在下单后5至7天内发出。',
            risk_flags=['model_warning', {'unexpected': 'shape'}],
        ), 'mock'))
        with patch('app.pipeline.generate_with_provider', provider), \
                patch('app.pipeline.search_documents', AsyncMock(return_value=[
                    {'snippet': '定制抱枕套通常在下单后5至7天内发货。'},
                ])) as search:
            result = await build_reply(ReplyRequest(
                platform='qianniu', message='下单后多久发货',
                product_base_ids=['products'], allow_auto_send=True,
            ))
        self.assertEqual(result.decision, 'auto_send')
        self.assertEqual(result.text, '亲亲，这款通常在下单后5至7天内发出。')
        self.assertEqual(result.model_calls, {'intent': 'mock', 'generation': 'same-call'})
        self.assertEqual(result.risk_flags, ['model_warning'])
        self.assertEqual(provider.await_count, 1)
        self.assertEqual(provider.await_args.kwargs['stage'], 'generation')
        self.assertTrue(provider.await_args.kwargs['json_mode'])
        self.assertIn('同时完成意图判断', provider.await_args.kwargs['system'])
        search.assert_awaited_once()

    async def test_email_unavailable_view_request_hands_off_without_model(self):
        for text in ['没有邮箱，怎么看图', '我无法提供邮箱号，如何看图', '邮箱给不了，看图入口在哪']:
            with self.subTest(text=text), patch('app.pipeline.generate_with_provider', AsyncMock()) as model, \
                    patch('app.pipeline.match_qa', AsyncMock()) as qa:
                result = await build_reply(ReplyRequest(platform='qianniu', message=text, qa_base_ids=['qa']))
            self.assertTrue(explicit_email_unavailable(text))
            self.assertEqual(result.decision, 'needs_human')
            self.assertEqual(result.action_plan.workflow, 'human_review')
            self.assertEqual(result.intent.reason, '客户无法通过邮箱接收看图资料')
            model.assert_not_awaited(); qa.assert_not_awaited()

    async def test_repeated_view_request_after_email_prompt_hands_off(self):
        request = ReplyRequest(platform='qianniu', message='怎么看图', qa_base_ids=['qa'], conversation=[
            {'role': 'assistant', 'content': '亲，请发送一下完整邮箱号哦~'},
        ])
        with patch('app.pipeline.generate_with_provider', AsyncMock()) as model, \
                patch('app.pipeline.match_qa', AsyncMock()) as qa:
            result = await build_reply(request)
        self.assertEqual(result.decision, 'needs_human')
        self.assertEqual(result.action_plan.workflow, 'human_review')
        model.assert_not_awaited(); qa.assert_not_awaited()

    def test_email_unavailable_does_not_match_delivery_failure(self):
        self.assertTrue(explicit_email_unavailable('没有邮箱'))
        self.assertFalse(explicit_email_unavailable('没有收到邮件'))
        self.assertFalse(explicit_email_unavailable('我的邮箱是3509932519@qq.com'))

    async def test_generic_view_access_uses_email_workflow_without_model_or_qa(self):
        for text in ['怎么看图', '图片在哪里看', '店铺看图链接地址', '看图入口在哪']:
            with self.subTest(text=text), patch('app.pipeline.generate_with_provider', AsyncMock()) as model, \
                    patch('app.pipeline.match_qa', AsyncMock()) as qa:
                result = await build_reply(ReplyRequest(platform='qianniu', message=text, qa_base_ids=['qa']))
            self.assertEqual(result.intent.image_delivery_intent, 'email_link_request')
            self.assertEqual(result.intent.intent, 'email_link_request')
            self.assertEqual(result.action_plan.workflow, 'collect_email_for_link')
            self.assertEqual(result.decision, 'suggest')
            self.assertEqual(result.text, '')
            model.assert_not_awaited(); qa.assert_not_awaited()

    async def test_specific_product_photo_request_still_hands_off(self):
        for text in ['看下这款抱枕的实物图', '发一下这个商品的实拍图', '能看看细节图吗']:
            with self.subTest(text=text), patch('app.pipeline.generate_with_provider', AsyncMock()) as model, \
                    patch('app.pipeline.match_qa', AsyncMock()) as qa:
                result = await build_reply(ReplyRequest(platform='qianniu', message=text, qa_base_ids=['qa']))
            self.assertEqual(explicit_image_delivery_intent(text), 'photo_request')
            self.assertEqual(result.decision, 'needs_human')
            self.assertEqual(result.intent.image_delivery_intent, 'photo_request')
            model.assert_not_awaited(); qa.assert_not_awaited()

    def test_product_image_comparison_is_not_a_photo_delivery_request(self):
        for text in ['图片和实物一样吗', '我想看图片和实物一样吗', '图里的是什么材质']:
            with self.subTest(text=text):
                self.assertNotEqual(explicit_image_delivery_intent(text), 'photo_request')

    async def test_image_requests_handoff_before_model_qa_or_generation(self):
        for text in ['想看图', '能发张实拍图吗', '有图片吗', '有没有细节图看看', '发图',
                     '我想看看效果图', '不用发实拍图，但是给张细节图看看']:
            with self.subTest(text=text), patch('app.pipeline.generate_with_provider', AsyncMock()) as model, \
                    patch('app.pipeline.match_qa', AsyncMock()) as qa:
                result = await build_reply(ReplyRequest(platform='qianniu', message=text, qa_base_ids=['qa']))
                self.assertEqual(result.decision, 'needs_human')
                self.assertEqual(result.intent.image_request_intent, 'request')
                self.assertEqual(result.text, '')
                model.assert_not_awaited(); qa.assert_not_awaited()

    async def test_contextual_image_confirmation_precedes_qa(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(
                intent_json(image_request_intent='request'), 'mock'))) as model, \
                patch('app.pipeline.match_qa', AsyncMock()) as qa:
            result = await build_reply(ReplyRequest(platform='qianniu', message='好，发我看看',
                conversation=[{'role': 'assistant', 'content': '您需要看实拍图吗？'}], qa_base_ids=['qa']))
        self.assertEqual(result.decision, 'needs_human')
        self.assertEqual(result.intent.reason, '客户请求查看图片')
        self.assertIn('image_request_intent', model.call_args.kwargs['system'])
        qa.assert_not_awaited()

    async def test_image_negation_and_discussion_do_not_force_transfer(self):
        for text in ['不用发图', '我发图片给你看看', '我给你发图', '图片和实物一样吗',
                     '图里的是什么材质', '我想看图片和实物一样吗']:
            self.assertFalse(explicit_image_request(text), text)
            with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(
                    intent_json(image_request_intent='none'), 'mock'))), \
                    patch('app.pipeline.match_qa', AsyncMock(return_value={'matched': True, 'score': 1,
                        'entry': {'answer': '这款是枕套。'}})):
                result = await build_reply(ReplyRequest(platform='qianniu', message=text, qa_base_ids=['qa']))
            self.assertEqual(result.action_plan.workflow, 'qa_answer')

    async def test_other_platform_image_request_retains_existing_qa(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock()) as model, \
                patch('app.pipeline.match_qa', AsyncMock(return_value={'matched': True, 'score': 1,
                    'entry': {'answer': '好的'}})):
            result = await build_reply(ReplyRequest(platform='wechat', message='想看图', qa_base_ids=['qa']))
        self.assertEqual(result.action_plan.workflow, 'qa_answer')
        model.assert_not_awaited()

    async def test_partial_knowledge_can_require_human_after_retrieval(self):
        for generation in [json.dumps({'answerable': False, 'text': '', 'reason': '缺少具体工期'}), '无效协议输出']:
            with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[
                    (intent_json(), 'mock'), (generation, 'mock')])), \
                    patch('app.pipeline.search_documents', AsyncMock(return_value=[{'snippet': '支持来图制作'}])):
                result = await build_reply(ReplyRequest(platform='qianniu', message='这个复杂图案多久完成？', product_base_ids=['products']))
            self.assertEqual(result.decision, 'needs_human')
            self.assertEqual(result.text, '')
            self.assertEqual(result.retrieval_status, 'hit')

    async def test_supported_consultation_generates_answer_without_handoff(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[
                (intent_json(custom_order_intent='consultation'), 'mock'),
                (json.dumps({'answerable': True, 'text': '支持来图制作。', 'reason': '服务介绍明确支持'}), 'mock')])) as model, \
                patch('app.pipeline.search_documents', AsyncMock(return_value=[{'snippet': '支持来图制作'}])):
            result = await build_reply(ReplyRequest(platform='qianniu', message='支持定制吗？', product_base_ids=['products'], allow_auto_send=True))
        self.assertEqual(result.decision, 'auto_send')
        self.assertEqual(result.text, '支持来图制作。')
        self.assertEqual(model.await_count, 2)
        self.assertEqual(model.await_args_list[0].kwargs['stage'], 'intent')
        self.assertEqual(model.await_args_list[1].kwargs['stage'], 'generation')

    async def test_explicit_order_wins_over_qa(self):
        request = ReplyRequest(platform='qianniu', message='我要定制一个', qa_base_ids=['qa'])
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(intent_json(), 'mock'))), \
                patch('app.pipeline.match_qa', AsyncMock()) as qa:
            result = await build_reply(request)
        self.assertEqual(result.decision, 'needs_human')
        self.assertEqual(result.intent.custom_order_intent, 'proceed')
        qa.assert_not_awaited()

    async def test_contextual_confirmation_hands_off(self):
        request = ReplyRequest(platform='qianniu', message='需要', conversation=[{'role': 'assistant', 'content': '需要定制吗？'}])
        with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(
                intent_json(custom_order_intent='proceed'), 'mock'))) as model:
            result = await build_reply(request)
        self.assertEqual(result.action_plan.workflow, 'human_review')
        self.assertIn('custom_order_intent', model.call_args.kwargs['system'])
        self.assertIn('需要定制', model.call_args.kwargs['user'])

    async def test_consultation_and_negation_can_use_qa(self):
        for message in ['支持定制吗？', '不用定制，我只是问一下', '约稿一般多久？']:
            with patch('app.pipeline.generate_with_provider', AsyncMock(return_value=(
                    intent_json(custom_order_intent='consultation'), 'mock'))), \
                    patch('app.pipeline.match_qa', AsyncMock(return_value={'matched': True,
                        'score': 1, 'entry': {'answer': '支持来图制作，具体以方案确认为准。'}})):
                result = await build_reply(ReplyRequest(platform='qianniu', message=message, qa_base_ids=['qa']))
            self.assertEqual(result.action_plan.workflow, 'qa_answer')

    async def test_qa_words_rewrite_once(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[
                (intent_json(), 'mock'), ('您可以直接在当前会话中沟通。', 'mock')])) as model, \
                patch('app.pipeline.match_qa', AsyncMock(return_value={'matched': True, 'score': 1,
                    'entry': {'answer': '不能加我微信'}})):
            result = await build_reply(ReplyRequest(platform='qianniu', message='怎么联系', qa_base_ids=['qa'], allow_auto_send=True))
        self.assertEqual(model.await_count, 2)
        self.assertIsNone(blocked_word(result.text))
        self.assertEqual(result.decision, 'auto_send')

    async def test_failed_rewrite_never_sends_forbidden_fallback(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock(side_effect=[
                (intent_json(), 'mock'), ('不支持私聊', 'mock')])), \
                patch('app.pipeline.match_qa', AsyncMock(return_value={'matched': True, 'score': 1,
                    'entry': {'answer': 'VIP服务'}})):
            result = await build_reply(ReplyRequest(platform='qianniu', message='服务', qa_base_ids=['qa']))
        self.assertEqual(result.decision, 'needs_human')
        self.assertEqual(result.text, '')

    async def test_other_platform_qa_does_not_get_qianniu_policy(self):
        with patch('app.pipeline.generate_with_provider', AsyncMock()) as model, \
                patch('app.pipeline.match_qa', AsyncMock(return_value={'matched': True, 'score': 1,
                    'entry': {'answer': 'VIP服务'}})):
            result = await build_reply(ReplyRequest(platform='wechat', message='服务', qa_base_ids=['qa']))
        self.assertEqual(result.text, 'VIP服务')
        model.assert_not_awaited()
