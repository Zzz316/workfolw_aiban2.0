import ai

class luoji():
	def csh(self):
		#group_id_set,source_id_set,model_id_set,biaoqian,zhenshu,thresh,roi
		shedingxinxi = [[1,100,12,'person',5,0.1,[(0,0),(1920,0),(1920,1080),(0,1080)]],[1,100,[12,15],['tv','ok'],5,0.1,[(0,0),(1920,0),(1920,1080),(0,1080)]]]
		ai.AI.chushihua(self,shedingxinxi)
		return shedingxinxi
	def cvDrawBoxes(self,chushihua,shibiexinxi,alarm_queue):
		if chushihua == 1:
			self.shedingxinxi =luoji.csh(self)
			print(self.shedingxinxi)
			chushihua = 0
			return chushihua
		if chushihua== 0:
			print(self.shedingxinxi[0][3],ai.AI.identify(self,self.shedingxinxi[0],shibiexinxi))
			print(self.shedingxinxi[1][3],ai.AI.identify(self,self.shedingxinxi[1],shibiexinxi))

			# if ai.AI.identify(self,self.shedingxinxi[0],shibiexinxi) == True:
			# 	alarm_queue.put('ok')
				# ai.AI.clearall(self,1,100)
			return chushihua

		################传给luoji
		# config = configparser.ConfigParser()
		# config.read('./config.ini')
		# change = (config.get('Setting', 'change'))
		# print(change)
		# if change == '0':
		# 	ai_sum = [0, 0, 0]
		# 	step = [False, False ,False]
		# 	config.set('Setting', 'change', '1')
		# 	with open('./config.ini', "w+") as f:
		# 		config.write(f)
		#
		# ai_sum[0], step[0] = ai.identify(rtnresults, 'person', 5, ai_sum[0])
		# ai_sum[1], step[1] = ai.identify(rtnresults, 'cell phone', 5, ai_sum[1])
		#
		# if step[0]==False and step[1]==False:
		# 	return None,ai_sum,step
		# elif step[0]==True and step[1]==False:
		# 	return None,ai_sum,step
		# elif step[0]==False and step[1]==True:
		# 	ai_sum=[0,0]
		# 	step=[False,False]
		# 	return 'NG',ai_sum,step
		# elif step[0]==True and step[1]==True:
		# 	ai_sum=[0,0]
		# 	step=[False,False]
		# 	return 'OK',ai_sum,step

